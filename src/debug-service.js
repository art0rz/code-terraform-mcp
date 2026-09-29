import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const PROXY_PATH = fileURLToPath(new URL("./stdio-proxy.py", import.meta.url));

class DebugSession {
  constructor(workspace, document, options = {}) {
    this.id = randomUUID();
    this.workspace = workspace;
    this.document = document;
    this.options = options;
    this.sequence = 1;
    this.pending = new Map();
    this.events = [];
    this.eventSequence = 0;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.expectedExit = false;
    this.stderr = "";
  }

  /**
   * Connect to the script through the game's debug adapter.
   *
   * @param {Array<object>} breakpoints Initial breakpoints for the script.
   * @param {{ runIfIdle?: boolean }} [options] `launch` starts an idle script;
   *   `attach` only inspects a running one and ends the session if it is idle.
   */
  async start(breakpoints = [], { runIfIdle = false } = {}) {
    const adapter = path.join(path.dirname(this.workspace.serverPath), "debug-adapter.cjs");
    await access(adapter);
    this.child = spawn(this.options.pythonPath ?? process.env.CODE_TERRAFORM_PYTHON ?? "python3", [
      this.options.proxyPath ?? PROXY_PATH, this.options.nodePath ?? process.execPath, adapter
    ], { cwd: this.workspace.rootPath, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000); });
    this.child.on("error", (error) => this.fail(error, true));
    this.child.on("exit", (code) => this.fail(new Error(`Debug adapter exited (${code}). ${this.stderr}`), true));
    try {
      await this.request("initialize", {
        adapterID: "code-terraform", clientID: "code-terraform-docs-mcp", clientName: "Code: Terraform MCP",
        linesStartAt1: true, columnsStartAt1: true, pathFormat: "path"
      });
      await this.request(runIfIdle ? "launch" : "attach", { workspace: this.workspace.rootPath, script: this.document.absolutePath });
      if (breakpoints.length) await this.setBreakpoints(this.document, breakpoints);
      await this.request("configurationDone", {});
      return this;
    } catch (error) {
      await this.end();
      throw error;
    }
  }

  request(command, args = {}, timeoutMs = 15_000) {
    if (this.closed || !this.child?.stdin.writable) throw new Error("Debug session is closed.");
    const seq = this.sequence++;
    const message = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: args }));
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`${command} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
    });
    this.child.stdin.write(`Content-Length: ${message.length}\r\n\r\n`);
    this.child.stdin.write(message);
    return promise;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const match = this.buffer.subarray(0, end).toString("ascii").match(/Content-Length:\s*(\d+)/i);
      if (!match) return this.fail(new Error("Invalid debug adapter header."));
      const length = Number(match[1]);
      if (length > 8_000_000) return this.fail(new Error("Debug adapter message is too large."));
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      let message;
      try { message = JSON.parse(body.toString("utf8")); }
      catch { return this.fail(new Error("Invalid debug adapter JSON.")); }
      if (message.type === "response") {
        const pending = this.pending.get(message.request_seq);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.request_seq);
        if (message.success) pending.resolve(message.body ?? {});
        else pending.reject(new Error(`${message.command}: ${message.message ?? message.body?.error?.format ?? "failed"}`));
      } else if (message.type === "event") {
        this.events.push({ sequence: ++this.eventSequence, event: message.event, body: message.body ?? {} });
        if (this.events.length > 100) this.events.shift();
      }
    }
  }

  fail(error, unexpected = false) {
    if (this.closed) return;
    if (unexpected && !this.expectedExit) logger.warn(`Debug session ${this.id} ended unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child?.kill();
  }

  async setBreakpoints(document, breakpoints) {
    return this.request("setBreakpoints", {
      source: { path: document.absolutePath, name: path.basename(document.absolutePath) },
      breakpoints
    });
  }

  eventsAfter(cursor = 0) {
    return { sessionId: this.id, closed: this.closed, nextCursor: this.eventSequence,
      events: this.events.filter((event) => event.sequence > cursor) };
  }

  async end() {
    this.expectedExit = true;
    if (!this.closed) {
      try { await this.request("disconnect", {}, 5_000); } catch { /* adapter may have exited */ }
    }
    this.fail(new Error("Debug session ended."));
  }
}

export class DebugService {
  constructor(workspaceStore, options = {}) {
    this.workspaceStore = workspaceStore;
    this.options = options;
    this.sessions = new Map();
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown debug session ${sessionId}.`);
    return session;
  }

  async start(target, breakpoints = [], { runIfIdle = false } = {}) {
    for (const [id, session] of this.sessions) if (session.closed) this.sessions.delete(id);
    if (this.sessions.size >= 4) throw new Error("At most four debug sessions are supported.");
    const { workspace, document } = await this.workspaceStore.resolveTarget(target);
    if (document.kind !== "script") throw new Error("Only registered scripts can start a debug session.");
    await this.workspaceStore.verifyDocumentFile(workspace, document);
    const session = new DebugSession(workspace, document, this.options);
    await session.start(breakpoints, { runIfIdle });
    this.sessions.set(session.id, session);
    return session;
  }

  async setBreakpoints(sessionId, target, breakpoints) {
    const session = this.get(sessionId);
    const { workspace, document } = await this.workspaceStore.resolveTarget(target);
    if (workspace.rootPath !== session.workspace.rootPath) throw new Error("Target belongs to another workspace.");
    await this.workspaceStore.verifyDocumentFile(workspace, document);
    return session.setBreakpoints(document, breakpoints);
  }

  async end(sessionId) {
    const session = this.get(sessionId);
    await session.end();
    this.sessions.delete(sessionId);
  }

  async dispose() {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.end()));
    this.sessions.clear();
  }
}
