import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listSections, resolveEntry, searchManual } from "./search.js";
import { registerExtraTools } from "./extra-tools.js";
import { logger } from "./logger.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const searchResultSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  badge: z.string(),
  section: z.string(),
  group: z.string(),
  url: z.string(),
  score: z.number(),
  snippet: z.string()
});

const positionInputSchema = {
  line: z.number().int().min(1).describe("One-based source line."),
  column: z.number().int().min(1).describe("One-based source column.")
};

const rangeSchema = z.object({
  start: z.object({ line: z.number().int(), column: z.number().int() }),
  end: z.object({ line: z.number().int(), column: z.number().int() })
});

const diagnosticSchema = z.object({
  severity: z.string(),
  message: z.string(),
  range: rangeSchema,
  code: z.string().optional(),
  source: z.string().optional()
});

function errorResult(tool, error) {
  logger.warn(`${tool} failed: ${error instanceof Error ? error.message : String(error)}`);
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
  };
}

function searchSummary(query, results) {
  if (results.length === 0) return `No manual entries matched “${query}”.`;
  const lines = results.map((result) => (
    `- [${result.id}] ${result.title} — ${result.section}${result.group ? ` / ${result.group}` : ""}\n  ${result.snippet}`
  ));
  return `Found ${results.length} manual ${results.length === 1 ? "entry" : "entries"} for “${query}”:\n\n${lines.join("\n")}`;
}

export function createServer(store, options = {}) {
  const workspaceStore = options.workspaceStore ?? null;
  const languageService = options.languageService ?? null;
  const debugService = options.debugService ?? null;
  const server = new McpServer(
    { name: "code-terraform-docs", version: "1.2.0" },
    {
      instructions: "Use search_manual and get_manual_entry for authoritative Code: Terraform APIs and mechanics. Use list_script_targets to select a registered owner context. Source analysis is in-memory. get_game_status and list_fleet read game-published state. Run, Stop, Library, and debug control tools change the live game; call them only when the user requests those actions. Debug sessions persist until debug_end or server shutdown."
    }
  );

  server.registerTool(
    "search_manual",
    {
      title: "Search the Code: Terraform manual",
      description: "Search the local game manual by concept, API symbol, method, component, type, heading, or prose. Returns ranked entry IDs and snippets; call get_manual_entry for the full authoritative text.",
      inputSchema: {
        query: z.string().min(1).describe("Words, an API symbol, or a question to search for."),
        section: z.string().min(1).optional().describe("Optional section or group filter, such as Components or Guide."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results. Defaults to 8; maximum 20.")
      },
      outputSchema: {
        query: z.string(),
        build: z.string(),
        resultCount: z.number().int(),
        results: z.array(searchResultSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({ query, section, limit }) => {
      try {
        const manual = await store.load();
        const results = searchManual(manual, query, { section, limit });
        const structuredContent = { query, build: manual.build, resultCount: results.length, results };
        return { structuredContent, content: [{ type: "text", text: searchSummary(query, results) }] };
      } catch (error) {
        return errorResult("search_manual", error);
      }
    }
  );

  server.registerTool(
    "get_manual_entry",
    {
      title: "Read a Code: Terraform manual entry",
      description: "Read the complete authoritative Markdown for one manual entry. Prefer a numeric ID returned by search_manual; titles and generated URLs are also accepted when unambiguous.",
      inputSchema: {
        identifier: z.union([z.number().int().nonnegative(), z.string().min(1)]).describe("Numeric entry ID, exact title, slug, or generated URL.")
      },
      outputSchema: {
        build: z.string(),
        entry: z.object({
          id: z.number().int(),
          title: z.string(),
          badge: z.string(),
          section: z.string(),
          group: z.string(),
          hierarchy: z.string(),
          headings: z.array(z.string()),
          url: z.string(),
          sourceLineStart: z.number().int(),
          sourceLineEnd: z.number().int(),
          markdown: z.string()
        })
      },
      annotations: readOnlyAnnotations
    },
    async ({ identifier }) => {
      try {
        const manual = await store.load();
        const entry = resolveEntry(manual, identifier);
        const metadata = {
          id: entry.id,
          title: entry.title,
          badge: entry.badge,
          section: entry.section,
          group: entry.group,
          hierarchy: entry.hierarchy,
          headings: entry.headings,
          url: entry.url,
          sourceLineStart: entry.sourceLineStart,
          sourceLineEnd: entry.sourceLineEnd,
          // Clients that surface only structuredContent (the Claude desktop app) would otherwise never see the entry text.
          markdown: entry.markdown
        };
        return {
          structuredContent: { build: manual.build, entry: metadata },
          content: [{ type: "text", text: `Manual build ${manual.build} · entry ${entry.id}\n\n${entry.markdown}` }]
        };
      } catch (error) {
        return errorResult("get_manual_entry", error);
      }
    }
  );

  server.registerTool(
    "list_manual_sections",
    {
      title: "List Code: Terraform manual sections",
      description: "Browse the manual hierarchy and entry counts before narrowing a search.",
      inputSchema: {},
      outputSchema: {
        build: z.string(),
        entryCount: z.number().int(),
        sections: z.array(z.object({
          name: z.string(),
          entryCount: z.number().int(),
          groups: z.array(z.object({ name: z.string(), entryCount: z.number().int() }))
        }))
      },
      annotations: readOnlyAnnotations
    },
    async () => {
      try {
        const manual = await store.load();
        const sections = listSections(manual);
        const structuredContent = { build: manual.build, entryCount: manual.entryCount, sections };
        const text = sections.map((section) => `- ${section.name}: ${section.entryCount} entries`).join("\n");
        return { structuredContent, content: [{ type: "text", text: `Manual build ${manual.build}\n\n${text}` }] };
      } catch (error) {
        return errorResult("list_manual_sections", error);
      }
    }
  );

  server.registerTool(
    "get_manual_build",
    {
      title: "Get Code: Terraform manual build",
      description: "Report the loaded manual's build identifier, size, entry count, timestamps, and source path for freshness checks.",
      inputSchema: {},
      outputSchema: {
        build: z.string(),
        entryCount: z.number().int(),
        byteSize: z.number().int(),
        sourcePath: z.string(),
        modifiedAt: z.string(),
        loadedAt: z.string()
      },
      annotations: readOnlyAnnotations
    },
    async () => {
      try {
        const manual = await store.load();
        const structuredContent = {
          build: manual.build,
          entryCount: manual.entryCount,
          byteSize: manual.byteSize,
          sourcePath: manual.sourcePath,
          modifiedAt: manual.modifiedAt,
          loadedAt: manual.loadedAt
        };
        return {
          structuredContent,
          content: [{ type: "text", text: `Code: Terraform manual build ${manual.build}: ${manual.entryCount} entries, ${manual.byteSize} bytes. Last modified ${manual.modifiedAt}.` }]
        };
      } catch (error) {
        return errorResult("get_manual_build", error);
      }
    }
  );

  server.registerTool(
    "list_script_targets",
    {
      title: "List game-aware script targets",
      description: "List scripts and Libraries registered in the configured live Code: Terraform workspace. Use an ID or path from this result as the target for the language tools.",
      inputSchema: {
        kind: z.enum(["script", "library"]).optional().describe("Optionally return only scripts or Libraries."),
        ownerType: z.string().min(1).optional().describe("Optionally filter scripts by component type, such as pioneer or fabricator."),
        query: z.string().min(1).optional().describe("Optional case-insensitive substring filter over ID, path, and owner type."),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum targets. Defaults to 200.")
      },
      outputSchema: {
        workspace: z.string(),
        saveId: z.string().nullable(),
        analysisVersion: z.string(),
        resultCount: z.number().int(),
        totalMatched: z.number().int(),
        targets: z.array(z.object({
          id: z.string(),
          path: z.string(),
          kind: z.string(),
          ownerType: z.string().nullable()
        }))
      },
      annotations: readOnlyAnnotations
    },
    async ({ kind, ownerType, query, limit = 200 }) => {
      try {
        if (!workspaceStore) throw new Error("Code: Terraform workspace support is unavailable.");
        const workspace = await workspaceStore.load();
        const needle = query?.toLowerCase();
        const matched = workspace.documents.filter((document) => (
          (!kind || document.kind === kind)
          && (!ownerType || document.ownerType === ownerType)
          && (!needle || `${document.id}\n${document.path}\n${document.ownerType ?? ""}`.toLowerCase().includes(needle))
        ));
        const targets = matched.slice(0, limit).map(({ id, path, kind: documentKind, ownerType: documentOwnerType }) => ({
          id, path, kind: documentKind, ownerType: documentOwnerType
        }));
        const structuredContent = {
          workspace: workspace.rootPath,
          saveId: workspace.saveId,
          analysisVersion: workspace.analysisVersion,
          resultCount: targets.length,
          totalMatched: matched.length,
          targets
        };
        return {
          structuredContent,
          content: [{ type: "text", text: `Code: Terraform analysis ${workspace.analysisVersion}: ${targets.length} of ${matched.length} matching target(s).\n\n${targets.map((target) => `- ${target.id} (${target.kind}${target.ownerType ? `, ${target.ownerType}` : ""}) — ${target.path}`).join("\n")}` }]
        };
      } catch (error) {
        return errorResult("list_script_targets", error);
      }
    }
  );

  server.registerTool(
    "validate_script",
    {
      title: "Validate a game script",
      description: "Analyze supplied Python source in the owner-specific context of a registered game script or Library. Source stays in memory and the live workspace file is not changed.",
      inputSchema: {
        target: z.string().min(1).describe("Registered target ID or path from list_script_targets."),
        source: z.string().max(1_000_000).describe("Complete Python source to validate."),
        timeoutMs: z.number().int().min(1_000).max(60_000).optional().describe("Diagnostic timeout. Defaults to 15000 ms.")
      },
      outputSchema: {
        target: z.string(),
        path: z.string(),
        ownerType: z.string().nullable(),
        analysisVersion: z.string(),
        valid: z.boolean(),
        diagnosticCount: z.number().int(),
        diagnostics: z.array(diagnosticSchema)
      },
      annotations: readOnlyAnnotations
    },
    async ({ target, source, timeoutMs }) => {
      try {
        if (!languageService) throw new Error("Code: Terraform language service is unavailable.");
        const result = await languageService.validate(target, source, timeoutMs);
        const structuredContent = {
          target: result.document.id,
          path: result.document.path,
          ownerType: result.document.ownerType,
          analysisVersion: result.workspace.analysisVersion,
          valid: !result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
          diagnosticCount: result.diagnostics.length,
          diagnostics: result.diagnostics
        };
        const summary = structuredContent.diagnosticCount === 0
          ? `No diagnostics for ${structuredContent.target}.`
          : `${structuredContent.diagnosticCount} diagnostic(s) for ${structuredContent.target}:\n\n${structuredContent.diagnostics.map((diagnostic) => `- ${diagnostic.severity} ${diagnostic.range.start.line}:${diagnostic.range.start.column} — ${diagnostic.message}`).join("\n")}`;
        return { structuredContent, content: [{ type: "text", text: summary }] };
      } catch (error) {
        return errorResult("validate_script", error);
      }
    }
  );

  server.registerTool(
    "inspect_symbol",
    {
      title: "Inspect a game-aware symbol",
      description: "Return hover, call-signature, and definition information at one source position using the selected component's real game context.",
      inputSchema: {
        target: z.string().min(1).describe("Registered target ID or path from list_script_targets."),
        source: z.string().max(1_000_000).describe("Complete Python source containing the position."),
        ...positionInputSchema
      },
      outputSchema: {
        target: z.string(),
        path: z.string(),
        ownerType: z.string().nullable(),
        analysisVersion: z.string(),
        hover: z.object({ contents: z.string().nullable(), range: rangeSchema.nullable() }).nullable(),
        signature: z.object({
          activeSignature: z.number().int(),
          activeParameter: z.number().int(),
          signatures: z.array(z.object({
            label: z.string(),
            documentation: z.string().nullable(),
            parameters: z.array(z.object({ label: z.string(), documentation: z.string().nullable() }))
          }))
        }).nullable(),
        definitions: z.array(z.object({ uri: z.string(), range: rangeSchema.nullable() }))
      },
      annotations: readOnlyAnnotations
    },
    async ({ target, source, line, column }) => {
      try {
        if (!languageService) throw new Error("Code: Terraform language service is unavailable.");
        const result = await languageService.inspect(target, source, { line, column });
        const structuredContent = {
          target: result.document.id,
          path: result.document.path,
          ownerType: result.document.ownerType,
          analysisVersion: result.workspace.analysisVersion,
          hover: result.hover,
          signature: result.signature,
          definitions: result.definitions
        };
        const parts = [];
        if (result.hover?.contents) parts.push(`Hover:\n${result.hover.contents}`);
        if (result.signature?.signatures?.length) parts.push(`Signatures:\n${result.signature.signatures.map((signature) => `- ${signature.label}`).join("\n")}`);
        if (result.definitions.length) parts.push(`Definitions:\n${result.definitions.map((definition) => `- ${definition.uri}`).join("\n")}`);
        return { structuredContent, content: [{ type: "text", text: parts.join("\n\n") || `No symbol information at ${line}:${column}.` }] };
      } catch (error) {
        return errorResult("inspect_symbol", error);
      }
    }
  );

  server.registerTool(
    "complete_at",
    {
      title: "Complete game-aware code",
      description: "Return a small, optionally filtered completion list at one source position in the selected component's real game context.",
      inputSchema: {
        target: z.string().min(1).describe("Registered target ID or path from list_script_targets."),
        source: z.string().max(1_000_000).describe("Complete Python source containing the completion position."),
        ...positionInputSchema,
        query: z.string().min(1).optional().describe("Optional case-insensitive label substring filter."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum suggestions. Defaults to 20; maximum 50.")
      },
      outputSchema: {
        target: z.string(),
        path: z.string(),
        ownerType: z.string().nullable(),
        analysisVersion: z.string(),
        itemCount: z.number().int(),
        items: z.array(z.object({
          label: z.string(),
          kind: z.number().int().nullable(),
          detail: z.string().nullable(),
          documentation: z.string().nullable(),
          insertText: z.string().nullable()
        }))
      },
      annotations: readOnlyAnnotations
    },
    async ({ target, source, line, column, query, limit = 20 }) => {
      try {
        if (!languageService) throw new Error("Code: Terraform language service is unavailable.");
        const result = await languageService.complete(target, source, { line, column }, query, limit);
        const structuredContent = {
          target: result.document.id,
          path: result.document.path,
          ownerType: result.document.ownerType,
          analysisVersion: result.workspace.analysisVersion,
          itemCount: result.items.length,
          items: result.items
        };
        return {
          structuredContent,
          content: [{ type: "text", text: result.items.length ? result.items.map((item) => `- ${item.label}${item.detail ? ` — ${item.detail}` : ""}`).join("\n") : "No matching completions." }]
        };
      } catch (error) {
        return errorResult("complete_at", error);
      }
    }
  );

  registerExtraTools(server, { languageService, debugService });
  const connect = server.connect.bind(server);
  server.connect = (transport) => connect(withDialectFreeToolSchemas(transport));
  return server;
}

/**
 * Remove the JSON Schema dialect from tools/list responses sent on a transport.
 *
 * The SDK converts zod v4 schemas with a hardcoded draft-07 target. Clients
 * that validate with a 2020-12-only validator (the Claude desktop app) reject
 * every tool declaring draft-07. The generated schemas use no draft-07-only
 * keywords, so without the declaration they are valid 2020-12 schemas.
 * TODO: Remove once @modelcontextprotocol/sdk emits draft-2020-12 for zod v4.
 *
 * @param {import("@modelcontextprotocol/sdk/shared/transport.js").Transport} transport
 * @returns {import("@modelcontextprotocol/sdk/shared/transport.js").Transport}
 */
function withDialectFreeToolSchemas(transport) {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(withoutToolSchemaDialects(message), options);
  return transport;
}

/**
 * @param {object} message JSON-RPC message.
 * @returns {object} The message, with tool schema dialects removed from a tool list result.
 */
function withoutToolSchemaDialects(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.map((tool) => ({
        ...tool,
        inputSchema: withoutDialect(tool.inputSchema),
        ...(tool.outputSchema && { outputSchema: withoutDialect(tool.outputSchema) })
      }))
    }
  };
}

/**
 * @param {object} schema JSON Schema.
 * @returns {object} The schema without its top-level `$schema` declaration.
 */
function withoutDialect(schema) {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}
