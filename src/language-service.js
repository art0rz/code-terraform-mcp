import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDERR = 8_000;
const DEFAULT_PROXY_PATH = fileURLToPath(new URL("./stdio-proxy.py", import.meta.url));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function markdownText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markdownText).filter(Boolean).join("\n\n");
  if (typeof value.language === "string" && typeof value.value === "string") {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }
  if (typeof value.value === "string") return value.value;
  return JSON.stringify(value);
}

function normalizePosition(position) {
  return { line: position.line - 1, character: position.column - 1 };
}

function normalizeRange(range) {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 }
  };
}

function normalizeDiagnostic(diagnostic) {
  const severityNames = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
  const output = {
    severity: severityNames[diagnostic.severity] ?? "unknown",
    message: String(diagnostic.message ?? ""),
    range: normalizeRange(diagnostic.range)
  };
  if (diagnostic.code !== undefined) output.code = String(diagnostic.code);
  if (diagnostic.source !== undefined) output.source = String(diagnostic.source);
  return output;
}

function normalizeLocation(location) {
  const range = location.targetSelectionRange ?? location.targetRange ?? location.range;
  return {
    uri: location.targetUri ?? location.uri,
    range: range ? normalizeRange(range) : null
  };
}

class LspSession {
  constructor(workspace, options = {}) {
    this.workspace = workspace;
    this.nodePath = options.nodePath ?? process.execPath;
    this.pythonPath = options.pythonPath ?? process.env.CODE_TERRAFORM_PYTHON ?? "python3";
    this.proxyPath = options.proxyPath ?? DEFAULT_PROXY_PATH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // The game's server finds Ruff on PATH and in common install locations; this overrides that search.
    this.ruffPath = options.ruffPath ?? process.env.CODE_TERRAFORM_RUFF ?? null;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.diagnosticWaiters = new Map();
    this.latestDiagnostics = new Map();
    this.stderr = "";
    this.version = 0;
    this.initialized = false;
    this.expectedExit = false;
    this.gameStatus = null;
    this.fleet = null;
  }

  async start() {
    this.child = spawn(this.pythonPath, [this.proxyPath, this.nodePath, this.workspace.serverPath, "--stdio"], {
      cwd: this.workspace.rootPath,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.expectedExit) {
        const detail = this.stderr.trim() ? ` ${this.stderr.trim()}` : "";
        logger.warn(`Language server exited unexpectedly (${code ?? signal}).`);
        this.failAll(new Error(`Code: Terraform language server exited (${code ?? signal}).${detail}`));
      }
      this.initialized = false;
    });

    const initializeResult = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "code-terraform-docs-mcp", version: "1.2.0" },
      initializationOptions: { notifications: true, ...(this.ruffPath && { formatter: { ruffPath: this.ruffPath } }) },
      locale: "en",
      rootPath: this.workspace.rootPath,
      rootUri: this.workspace.rootUri,
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          completion: { completionItem: { documentationFormat: ["markdown", "plaintext"], snippetSupport: false } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
          definition: { linkSupport: true }
        }
      },
      workspaceFolders: [{ uri: this.workspace.rootUri, name: path.basename(this.workspace.rootPath) }]
    });
    this.capabilities = initializeResult?.capabilities ?? {};
    this.notify("initialized", {});
    this.initialized = true;
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error("Code: Terraform language server is not running.");
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method, params, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.send({ id, method, params });
    return withTimeout(response, timeoutMs, method).finally(() => this.pending.delete(id));
  }

  notify(method, params) {
    this.send({ method, params });
  }

  respond(id, result = null, error = null) {
    this.send(error ? { id, error } : { id, result });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.failAll(new Error("Language server sent an invalid JSON-RPC header."));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch (error) {
        this.failAll(new Error(`Invalid language server message: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  onMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? "language server error"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const diagnostics = Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : [];
      this.latestDiagnostics.set(message.params.uri, diagnostics);
      const waiters = this.diagnosticWaiters.get(message.params.uri) ?? [];
      this.diagnosticWaiters.delete(message.params.uri);
      for (const waiter of waiters) waiter.resolve(diagnostics);
    }
    if (message.method === "codeterraform/status") this.gameStatus = message.params ?? null;
    if (message.method === "codeterraform/fleet") this.fleet = message.params?.fleet ?? null;
  }

  handleServerRequest(message) {
    if (message.method === "workspace/configuration") {
      this.respond(message.id, (message.params?.items ?? []).map(() => null));
      return;
    }
    if (message.method === "workspace/workspaceFolders") {
      this.respond(message.id, [{ uri: this.workspace.rootUri, name: path.basename(this.workspace.rootPath) }]);
      return;
    }
    if (message.method === "workspace/applyEdit") {
      this.respond(message.id, { applied: false, failureReason: "Read-only MCP client" });
      return;
    }
    this.respond(message.id, null);
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.diagnosticWaiters.clear();
  }

  waitForDiagnostics(uri, timeoutMs) {
    this.latestDiagnostics.delete(uri);
    const promise = new Promise((resolve, reject) => {
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push({ resolve, reject });
      this.diagnosticWaiters.set(uri, waiters);
    });
    return withTimeout(promise, timeoutMs, "diagnostics").finally(() => this.diagnosticWaiters.delete(uri));
  }

  open(document, source) {
    this.version += 1;
    this.notify("textDocument/didOpen", {
      textDocument: { uri: document.uri, languageId: "python", version: this.version, text: source }
    });
  }

  close(document) {
    if (this.child?.stdin.writable) this.notify("textDocument/didClose", { textDocument: { uri: document.uri } });
  }

  async validate(document, source, timeoutMs) {
    const diagnostics = this.waitForDiagnostics(document.uri, timeoutMs);
    this.open(document, source);
    try {
      return (await diagnostics).map(normalizeDiagnostic);
    } finally {
      this.close(document);
    }
  }

  async inspect(document, source, position) {
    this.open(document, source);
    const params = { textDocument: { uri: document.uri }, position: normalizePosition(position) };
    try {
      const [hover, signature, definition] = await Promise.all([
        this.request("textDocument/hover", params),
        this.request("textDocument/signatureHelp", params),
        this.request("textDocument/definition", params)
      ]);
      const definitions = definition == null ? [] : (Array.isArray(definition) ? definition : [definition]);
      return {
        hover: hover ? { contents: markdownText(hover.contents), range: hover.range ? normalizeRange(hover.range) : null } : null,
        signature: signature ? {
          activeSignature: signature.activeSignature ?? 0,
          activeParameter: signature.activeParameter ?? 0,
          signatures: (signature.signatures ?? []).map((item) => ({
            label: item.label,
            documentation: markdownText(item.documentation),
            parameters: (item.parameters ?? []).map((parameter) => ({
              label: Array.isArray(parameter.label) ? parameter.label.join(":") : String(parameter.label),
              documentation: markdownText(parameter.documentation)
            }))
          }))
        } : null,
        definitions: definitions.map(normalizeLocation)
      };
    } finally {
      this.close(document);
    }
  }

  async complete(document, source, position, query, limit) {
    this.open(document, source);
    try {
      const response = await this.request("textDocument/completion", {
        textDocument: { uri: document.uri },
        position: normalizePosition(position),
        context: { triggerKind: 1 }
      });
      const rawItems = Array.isArray(response) ? response : (response?.items ?? []);
      const needle = query?.toLowerCase();
      return rawItems
        .filter((item) => !needle || String(item.label).toLowerCase().includes(needle))
        .slice(0, limit)
        .map((item) => ({
          label: String(item.label),
          kind: item.kind ?? null,
          detail: item.detail ?? null,
          documentation: markdownText(item.documentation),
          insertText: item.insertText ?? item.textEdit?.newText ?? null
        }));
    } finally {
      this.close(document);
    }
  }

  async documentRequest(document, source, method, params, timeoutMs = this.timeoutMs) {
    this.open(document, source);
    try {
      return await this.request(method, { textDocument: { uri: document.uri }, ...params }, timeoutMs);
    } finally {
      this.close(document);
    }
  }

  async gameCommand(command, argument) {
    return this.request("codeterraform/gameCommand", { command, arguments: [argument] }, 25_000);
  }

  async dispose() {
    if (!this.child) return;
    try {
      await this.request("shutdown", null, 2_000);
      this.expectedExit = true;
      const exited = new Promise((resolve) => this.child.once("exit", resolve));
      this.notify("exit", null);
      await Promise.race([exited, delay(500)]);
    } catch {
      // Best-effort shutdown; the owning MCP process is also exiting.
    }
    if (!this.child.killed) this.child.kill();
    this.child = null;
  }
}

export class LanguageService {
  constructor(workspaceStore, options = {}) {
    this.workspaceStore = workspaceStore;
    this.options = options;
    this.session = null;
    this.signature = null;
    this.queue = Promise.resolve();
  }

  runExclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async sessionFor(workspace) {
    const signature = `${workspace.rootPath}\0${workspace.serverPath}\0${workspace.analysisVersion}`;
    if (this.session && (this.signature !== signature || !this.session.initialized)) {
      logger.info(`Restarting language server (${this.signature !== signature ? "workspace changed" : "session ended"}).`);
      await this.session.dispose();
      this.session = null;
    }
    if (!this.session) {
      this.session = new LspSession(workspace, this.options);
      await this.session.start();
      this.signature = signature;
      logger.info(`Language server ready for analysis ${workspace.analysisVersion}.`);
    }
    return this.session;
  }

  async validate(target, source, timeoutMs = 15_000) {
    return this.runExclusive(async () => {
      const { workspace, document } = await this.workspaceStore.resolveTarget(target);
      const session = await this.sessionFor(workspace);
      const diagnostics = await session.validate(document, source, timeoutMs);
      return { workspace, document, diagnostics };
    });
  }

  async inspect(target, source, position) {
    return this.runExclusive(async () => {
      const { workspace, document } = await this.workspaceStore.resolveTarget(target);
      const session = await this.sessionFor(workspace);
      return { workspace, document, ...(await session.inspect(document, source, position)) };
    });
  }

  async complete(target, source, position, query, limit) {
    return this.runExclusive(async () => {
      const { workspace, document } = await this.workspaceStore.resolveTarget(target);
      const session = await this.sessionFor(workspace);
      return { workspace, document, items: await session.complete(document, source, position, query, limit) };
    });
  }

  async documentRequest(target, source, method, params = {}) {
    return this.runExclusive(async () => {
      const { workspace, document } = await this.workspaceStore.resolveTarget(target);
      const session = await this.sessionFor(workspace);
      const result = await session.documentRequest(document, source, method, params);
      return { workspace, document, result, capabilities: session.capabilities };
    });
  }

  async gameCommand(command, target, options = {}) {
    return this.runExclusive(async () => {
      const { workspace, document } = await this.workspaceStore.resolveTarget(target);
      if (options.kind && document.kind !== options.kind) throw new Error(`Target ${target} must be a ${options.kind}.`);
      await this.workspaceStore.verifyDocumentFile(workspace, document);
      const session = await this.sessionFor(workspace);
      const result = await session.gameCommand(command, { uri: document.uri, ...options.arguments });
      return { workspace, document, result };
    });
  }

  async createLibrary(name) {
    return this.workspaceCommand("codeTerraform.createLibrary", { name });
  }

  async importLibrary(name, source) {
    return this.workspaceCommand("codeTerraform.importLibrary", { name, source });
  }

  /** Deploy every Library's saved source and restart the scripts that import them. */
  async applyAllLibraries() {
    return this.workspaceCommand("codeTerraform.applyAllLibraries", {});
  }

  /**
   * Send a game command that addresses the workspace rather than one registered document.
   *
   * @param {string} command Game command ID.
   * @param {object} argument Command argument.
   */
  async workspaceCommand(command, argument) {
    return this.runExclusive(async () => {
      const workspace = await this.workspaceStore.load();
      const session = await this.sessionFor(workspace);
      return { workspace, result: await session.gameCommand(command, argument) };
    });
  }

  async gameOverview() {
    return this.runExclusive(async () => {
      const workspace = await this.workspaceStore.load();
      const session = await this.sessionFor(workspace);
      for (let attempt = 0; !session.gameStatus && attempt < 20; attempt += 1) await delay(25);
      // Notifications can arrive just after initialize; the same published fleet
      // snapshot is available on disk for an immediate, deterministic response.
      let fleet = session.fleet;
      if (!fleet) {
        try { fleet = JSON.parse(await readFile(path.join(workspace.rootPath, "codeterraform-fleet.json"), "utf8")); }
        catch { fleet = null; }
      }
      return { workspace, status: session.gameStatus, fleet };
    });
  }

  async heartbeat() {
    return this.runExclusive(async () => {
      const workspace = await this.workspaceStore.load();
      const session = await this.sessionFor(workspace);
      const document = workspace.documents[0];
      if (document) await session.documentRequest(document, "", "textDocument/documentSymbol", {}, 5_000);
      return {
        responsive: Boolean(document),
        ready: session.gameStatus?.ready ?? null,
        fleetPublished: session.fleet !== null
      };
    });
  }

  async dispose() {
    await this.queue.catch(() => {});
    await this.session?.dispose();
    this.session = null;
  }
}
