import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ManualStore } from "../src/manual-store.js";
import { createServer } from "../src/server.js";
import { sampleManual } from "./fixtures.js";

test("MCP handshake lists and calls the manual and language tools", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-terraform-docs-mcp-protocol-"));
  const manualPath = path.join(directory, "manual.md");
  await writeFile(manualPath, sampleManual);

  const workspace = {
    rootPath: "/game/save_scripts",
    saveId: "save_test",
    analysisVersion: "analysis-test-1",
    documents: [
      { id: "pioneer_1", path: "pioneer_1.py", kind: "script", ownerType: "pioneer" },
      { id: "helpers", path: "lib/helpers.py", kind: "library", ownerType: "library" }
    ]
  };
  const workspaceStore = { load: async () => workspace };
  const languageService = {
    validate: async () => ({
      workspace,
      document: workspace.documents[0],
      diagnostics: [{ severity: "error", message: "Unknown member", range: { start: { line: 2, column: 6 }, end: { line: 2, column: 13 } }, source: "codeterraform" }]
    }),
    inspect: async () => ({
      workspace,
      document: workspace.documents[0],
      hover: { contents: "Pioneer owner", range: null },
      signature: null,
      definitions: []
    }),
    complete: async () => ({
      workspace,
      document: workspace.documents[0],
      items: [{ label: "battery", kind: 10, detail: "Battery", documentation: null, insertText: "battery" }]
    }),
    gameOverview: async () => ({ workspace, status: { ready: true }, fleet: { scripts: { pioneer_1: { status: "running", errorLine: null } } } }),
    documentRequest: async (_target, _source, method) => ({
      result: method === "textDocument/references" ? [{ uri: "file:///game/save_scripts/pioneer_1.py",
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } } }] : [],
      capabilities: {}
    }),
    gameCommand: async () => ({ result: { ok: true } })
  };
  const server = createServer(new ManualStore(manualPath), { workspaceStore, languageService });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => client.close());

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.slice(0, 8).map((tool) => tool.name),
    ["search_manual", "get_manual_entry", "list_manual_sections", "get_manual_build", "list_script_targets", "validate_script", "inspect_symbol", "complete_at"]);
  assert.ok(listed.tools.some((tool) => tool.name === "debug_start"));
  assert.equal(listed.tools.find((tool) => tool.name === "run_script").annotations.readOnlyHint, false);
  assert.equal(listed.tools.find((tool) => tool.name === "find_references").annotations.readOnlyHint, true);

  const searched = await client.callTool({
    name: "search_manual",
    arguments: { query: "vehicle charging station" }
  });
  assert.equal(searched.isError, undefined);
  assert.equal(searched.structuredContent.resultCount, 1);
  assert.equal(searched.structuredContent.results[0].id, 0);

  const fetched = await client.callTool({
    name: "get_manual_entry",
    arguments: { identifier: 0 }
  });
  assert.equal(fetched.structuredContent.entry.title, "Batteries & Charging");
  assert.match(fetched.content[0].text, /self\.charge\(\)/);

  const sections = await client.callTool({ name: "list_manual_sections", arguments: {} });
  assert.equal(sections.structuredContent.entryCount, 3);

  const build = await client.callTool({ name: "get_manual_build", arguments: {} });
  assert.equal(build.structuredContent.build, "test-build-42");

  const targets = await client.callTool({ name: "list_script_targets", arguments: { ownerType: "pioneer" } });
  assert.equal(targets.structuredContent.resultCount, 1);
  assert.equal(targets.structuredContent.targets[0].id, "pioneer_1");

  const validated = await client.callTool({ name: "validate_script", arguments: { target: "pioneer_1", source: "self.nope()" } });
  assert.equal(validated.structuredContent.valid, false);
  assert.equal(validated.structuredContent.diagnosticCount, 1);

  const inspected = await client.callTool({ name: "inspect_symbol", arguments: { target: "pioneer_1", source: "self", line: 1, column: 1 } });
  assert.equal(inspected.structuredContent.hover.contents, "Pioneer owner");

  const completed = await client.callTool({ name: "complete_at", arguments: { target: "pioneer_1", source: "self.", line: 1, column: 6 } });
  assert.equal(completed.structuredContent.items[0].label, "battery");

  const status = await client.callTool({ name: "get_game_status", arguments: {} });
  assert.equal(status.structuredContent.data.byStatus.running, 1);
  const refs = await client.callTool({ name: "find_references", arguments: { target: "pioneer_1", source: "helper", line: 1, column: 5 } });
  assert.equal(refs.structuredContent.data.references[0].range.start.column, 5);
  const run = await client.callTool({ name: "run_script", arguments: { target: "pioneer_1" } });
  assert.equal(run.structuredContent.data.ok, true);
});
