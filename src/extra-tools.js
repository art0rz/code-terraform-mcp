import { z } from "zod";
import { logger } from "./logger.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const changesGame = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const sourceInput = {
  target: z.string().min(1).describe("Registered target ID or path."),
  source: z.string().max(1_000_000).describe("Complete source analyzed in memory.")
};
const sessionInput = { sessionId: z.string().uuid() };
const breakpointSchema = z.object({
  line: z.number().int().min(1),
  condition: z.string().max(500).optional(),
  logMessage: z.string().max(500).optional()
});

function register(server, name, title, description, inputSchema, callback, mutates = false) {
  server.registerTool(name, {
    title, description, inputSchema, outputSchema: { data: z.unknown() },
    annotations: mutates ? changesGame : readOnly
  }, async (args) => {
    try {
      const data = await callback(args);
      if (mutates) logger.info(`${name} succeeded.`);
      return { structuredContent: { data }, content: [{ type: "text", text: JSON.stringify(data).slice(0, 50_000) }] };
    } catch (error) {
      logger.warn(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
}

const pos = (line, column) => ({ line: line - 1, character: column - 1 });
const point = (p) => ({ line: p.line + 1, column: p.character + 1 });
const range = (r) => ({ start: point(r.start), end: point(r.end) });
const edit = (e) => ({ range: range(e.range), newText: e.newText });

export function registerExtraTools(server, { languageService, debugService }) {
  const requireLanguage = () => {
    if (!languageService) throw new Error("Code: Terraform language service is unavailable.");
    return languageService;
  };
  const requireDebug = () => {
    if (!debugService) throw new Error("Code: Terraform debug service is unavailable.");
    return debugService;
  };

  register(server, "get_game_status", "Get game connection status",
    "Read the language server's game connection and the current registered script status summary.", {}, async () => {
      const { workspace, status, fleet } = await requireLanguage().gameOverview();
      const scripts = fleet?.scripts ?? {};
      const byStatus = {};
      for (const script of Object.values(scripts)) byStatus[script.status ?? "unknown"] = (byStatus[script.status ?? "unknown"] ?? 0) + 1;
      return { saveId: workspace.saveId, analysisVersion: workspace.analysisVersion, connection: status,
        fleetAvailable: !!fleet, scriptCount: Object.keys(scripts).length, byStatus };
    });

  register(server, "list_fleet", "List registered game objects and script states",
    "Read the game-published fleet snapshot, optionally filtering scripts by status or name.", {
      kind: z.enum(["scripts", "machines", "panels", "contracts", "libraries", "outposts"]).default("scripts"),
      query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).default(100)
    }, async ({ kind, query, limit }) => {
      const { fleet } = await requireLanguage().gameOverview();
      if (!fleet) throw new Error("No game fleet snapshot is available.");
      const items = kind === "scripts" ? Object.entries(fleet.scripts ?? {}).map(([id, value]) => ({ id, ...value })) : (fleet[kind] ?? []);
      const filtered = query ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase())) : items;
      return { kind, totalMatched: filtered.length, items: filtered.slice(0, limit) };
    });

  register(server, "list_script_symbols", "List document symbols", "Return functions, classes, and variables in supplied source.", sourceInput,
    async ({ target, source }) => {
      const { result } = await requireLanguage().documentRequest(target, source, "textDocument/documentSymbol");
      const convert = (item) => ({ name: item.name, kind: item.kind, detail: item.detail ?? null,
        range: item.range ? range(item.range) : null, selectionRange: item.selectionRange ? range(item.selectionRange) : null,
        children: (item.children ?? []).map(convert) });
      return { target, symbols: (result ?? []).map(convert) };
    });

  register(server, "find_references", "Find symbol references", "Find references at a source position, including the declaration if requested.", {
    ...sourceInput, line: z.number().int().min(1), column: z.number().int().min(1),
    includeDeclaration: z.boolean().default(true)
  }, async ({ target, source, line, column, includeDeclaration }) => {
    const { result } = await requireLanguage().documentRequest(target, source, "textDocument/references", {
      position: pos(line, column), context: { includeDeclaration }
    });
    return { target, references: (result ?? []).map((item) => ({ uri: item.uri, range: range(item.range) })) };
  });

  register(server, "preview_rename", "Preview symbol rename", "Return the LSP's proposed edits; do not apply them.", {
    ...sourceInput, line: z.number().int().min(1), column: z.number().int().min(1), newName: z.string().min(1).max(200)
  }, async ({ target, source, line, column, newName }) => {
    const { result } = await requireLanguage().documentRequest(target, source, "textDocument/rename", {
      position: pos(line, column), newName
    });
    return { target, changes: Object.fromEntries(Object.entries(result?.changes ?? {}).map(([uri, edits]) => [uri, edits.map(edit)])),
      documentChanges: result?.documentChanges ?? [] };
  });

  register(server, "get_semantic_tokens", "Get semantic tokens", "Return decoded LSP syntax tokens for supplied source.", {
    ...sourceInput, limit: z.number().int().min(1).max(2000).default(500)
  }, async ({ target, source, limit }) => {
    const { result, capabilities } = await requireLanguage().documentRequest(target, source, "textDocument/semanticTokens/full");
    const legend = capabilities?.semanticTokensProvider?.legend;
    let line = 0, character = 0;
    const tokens = [];
    const data = result?.data ?? [];
    for (let index = 0; index + 4 < data.length && tokens.length < limit; index += 5) {
      line += data[index];
      character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
      tokens.push({ line: line + 1, column: character + 1, length: data[index + 2],
        type: legend?.tokenTypes?.[data[index + 3]] ?? String(data[index + 3]),
        modifiers: (legend?.tokenModifiers ?? []).filter((_, bit) => data[index + 4] & (1 << bit)) });
    }
    return { target, totalTokens: data.length / 5, tokens };
  });

  register(server, "format_script", "Preview source formatting", "Return LSP formatting edits without applying them. Ruff must be installed.", {
    ...sourceInput, startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional()
  }, async ({ target, source, startLine, endLine }) => {
    if ((startLine === undefined) !== (endLine === undefined)) throw new Error("Supply both startLine and endLine, or neither.");
    const method = startLine === undefined ? "textDocument/formatting" : "textDocument/rangeFormatting";
    const params = { options: { tabSize: 4, insertSpaces: true } };
    if (startLine !== undefined) {
      const lines = source.split("\n");
      if (endLine < startLine || endLine > lines.length) throw new Error("Formatting line range is outside the source.");
      params.range = { start: pos(startLine, 1), end: { line: endLine - 1, character: lines[endLine - 1].length } };
    }
    const { result } = await requireLanguage().documentRequest(target, source, method, params);
    return { target, edits: (result ?? []).map(edit) };
  });

  register(server, "list_code_actions", "List LSP code actions", "List available actions without executing their commands.", sourceInput,
    async ({ target, source }) => {
      const lines = source.split("\n");
      const { result } = await requireLanguage().documentRequest(target, source, "textDocument/codeAction", {
        range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1).length } },
        context: { diagnostics: [] }
      });
      return { target, actions: (result ?? []).map((action) => ({ title: action.title, kind: action.kind ?? null,
        command: action.command?.command ?? null })) };
    });

  for (const [name, command] of [["run_script", "codeTerraform.run"], ["stop_script", "codeTerraform.stop"]]) {
    register(server, name, name === "run_script" ? "Run a game script" : "Stop a game script",
      "Send a game command for a registered script using its saved workspace source. Changes live game execution.",
      { target: z.string().min(1) }, async ({ target }) => {
        const { result } = await requireLanguage().gameCommand(command, target, { kind: "script" });
        return { target, ...result };
      }, true);
  }

  register(server, "create_library", "Create a game Library", "Create an empty Library in the live game.",
    { name: z.string().min(1).max(100) }, async ({ name }) => ({ name, ...(await requireLanguage().createLibrary(name)).result }), true);
  register(server, "import_library", "Import a game Library",
    "Create a new Library from supplied complete source in the live game. Fails with duplicate_name if the Library exists; "
    + "to update an existing Library, write its synced lib/<name>.py file in the save workspace instead.",
    { name: z.string().min(1).max(100), source: z.string().max(1_000_000) },
    async ({ name, source }) => ({ name, ...(await requireLanguage().importLibrary(name, source)).result }), true);
  register(server, "rename_library", "Rename a game Library", "Rename a registered Library in the live game.",
    { target: z.string().min(1), name: z.string().min(1).max(100) },
    async ({ target, name }) => ({ target, name, ...(await requireLanguage().gameCommand("codeTerraform.renameLibrary", target,
      { kind: "library", arguments: { name } })).result }), true);

  register(server, "debug_start", "Start a game debug session",
    "Open a persistent DAP session for a registered script. By default it attaches to a running script and never starts an idle one; "
    + "an idle script then ends the session at once. Set runIfIdle to start an idle script.", {
    target: z.string().min(1), breakpoints: z.array(breakpointSchema).max(100).default([]),
    runIfIdle: z.boolean().default(false).describe("Start the script if it is idle. Defaults to false: inspect only.")
  }, async ({ target, breakpoints, runIfIdle }) => {
    const session = await requireDebug().start(target, breakpoints, { runIfIdle });
    return { sessionId: session.id, target: session.document.id, ...session.eventsAfter() };
  }, true);
  register(server, "debug_set_breakpoints", "Set game breakpoints", "Replace breakpoints for a registered script or Library in a debug session.", {
    ...sessionInput, target: z.string().min(1), breakpoints: z.array(breakpointSchema).max(100)
  }, async ({ sessionId, target, breakpoints }) => ({ sessionId, target,
    result: await requireDebug().setBreakpoints(sessionId, target, breakpoints) }), true);
  register(server, "debug_control", "Control a game debug session", "Pause, continue, or step a game script.", {
    ...sessionInput, action: z.enum(["pause", "continue", "next", "stepIn", "stepOut"])
  }, async ({ sessionId, action }) => ({ sessionId, action, result: await requireDebug().get(sessionId).request(action) }), true);
  register(server, "debug_inspect", "Inspect a game debug session", "Read threads, stack frames, scopes, or variables.", {
    ...sessionInput, view: z.enum(["threads", "stackTrace", "scopes", "variables"]),
    frameId: z.number().int().optional(), variablesReference: z.number().int().optional()
  }, async ({ sessionId, view, frameId, variablesReference }) => {
    const args = view === "stackTrace" ? { threadId: 1 } : view === "scopes" ? { frameId } : view === "variables" ? { variablesReference } : {};
    if (view === "scopes" && frameId === undefined) throw new Error("frameId is required for scopes.");
    if (view === "variables" && variablesReference === undefined) throw new Error("variablesReference is required for variables.");
    return { sessionId, view, result: await requireDebug().get(sessionId).request(view, args) };
  });
  register(server, "debug_evaluate", "Evaluate while debugging", "Evaluate an expression in a halted game script. Expressions may call game APIs.", {
    ...sessionInput, expression: z.string().min(1).max(2000), frameId: z.number().int().optional()
  }, async ({ sessionId, expression, frameId }) => ({ sessionId,
    result: await requireDebug().get(sessionId).request("evaluate", { expression, frameId, context: "watch" }) }), true);
  register(server, "debug_events", "Read debug events", "Read recent stopped, continued, and console output events after a cursor.", {
    ...sessionInput, after: z.number().int().min(0).default(0)
  }, async ({ sessionId, after }) => requireDebug().get(sessionId).eventsAfter(after));
  register(server, "debug_end", "End a debug session", "Detach the debugger; the game script is not stopped.", sessionInput,
    async ({ sessionId }) => { await requireDebug().end(sessionId); return { sessionId, ended: true }; }, true);
}
