import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ManualStore } from "../src/manual-store.js";
import { createServer } from "../src/server.js";
import { LanguageService } from "../src/language-service.js";
import { WorkspaceStore } from "../src/workspace-store.js";
import { z } from "zod";
import { sampleManual } from "./fixtures.js";

function at(value: unknown, ...keys: (string | number)[]): unknown {
  for (const key of keys) {
    assert.ok(value !== null && typeof value === "object");
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

void test("MCP handshake lists and calls the manual and language tools", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-terraform-docs-mcp-protocol-"));
  const manualPath = path.join(directory, "manual.md");
  await writeFile(manualPath, sampleManual);

  const workspace = {
    rootUri: "file:///game/save_scripts",
    markerPath: "/game/save_scripts/codeterraform-workspace.json",
    serverPath: "/fake.cjs",
    language: "python",
    rootPath: "/game/save_scripts",
    saveId: "save_test",
    analysisVersion: "analysis-test-1",
    documents: [
      {
        id: "pioneer_1",
        path: "pioneer_1.py",
        kind: "script",
        ownerType: "pioneer",
        absolutePath: "/game/save_scripts/pioneer_1.py",
        uri: "file:///game/save_scripts/pioneer_1.py",
      },
      {
        id: "helpers",
        path: "lib/helpers.py",
        kind: "library",
        ownerType: "library",
        absolutePath: "/game/save_scripts/lib/helpers.py",
        uri: "file:///game/save_scripts/lib/helpers.py",
      },
    ],
  };
  const workspaceStore = new WorkspaceStore();
  context.mock.method(workspaceStore, "load", async () => workspace);
  const gameCommands: { command: string; target?: string; kind?: string | undefined }[] = [];
  const languageService = new LanguageService(workspaceStore);
  const mocks = {
    validate: async () => ({
      workspace,
      document: workspace.documents[0]!,
      diagnostics: [
        {
          severity: "error",
          message: "Unknown member",
          range: { start: { line: 2, column: 6 }, end: { line: 2, column: 13 } },
          source: "codeterraform",
        },
      ],
    }),
    inspect: async () => ({
      workspace,
      document: workspace.documents[0]!,
      hover: { contents: "Pioneer owner", range: null },
      signature: null,
      definitions: [],
    }),
    complete: async () => ({
      workspace,
      document: workspace.documents[0]!,
      items: [
        {
          label: "battery",
          kind: 10,
          detail: "Battery",
          documentation: null,
          insertText: "battery",
        },
      ],
    }),
    gameOverview: async () => ({
      workspace,
      status: { ready: true },
      fleet: { scripts: { pioneer_1: { status: "running", errorLine: null } } },
    }),
    documentRequest: async (_target: string, _source: string, method: string) => ({
      result:
        method === "textDocument/references"
          ? [
              {
                uri: "file:///game/save_scripts/pioneer_1.py",
                range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
              },
            ]
          : [],
      capabilities: {},
    }),
    gameCommand: async (command: string, target: string, options: { kind?: string }) => {
      gameCommands.push({ command, target, kind: options.kind });
      return { result: { ok: true } };
    },
    applyAllLibraries: async () => {
      gameCommands.push({ command: "codeTerraform.applyAllLibraries" });
      return { result: { ok: true } };
    },
  };
  context.mock.method(languageService, "validate", mocks.validate);
  context.mock.method(languageService, "inspect", mocks.inspect);
  context.mock.method(languageService, "complete", mocks.complete);
  context.mock.method(languageService, "gameOverview", mocks.gameOverview);
  context.mock.method(languageService, "documentRequest", mocks.documentRequest);
  context.mock.method(languageService, "gameCommand", mocks.gameCommand);
  context.mock.method(languageService, "applyAllLibraries", mocks.applyAllLibraries);
  const server = createServer(new ManualStore(manualPath), { workspaceStore, languageService });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => client.close());

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.slice(0, 8).map((tool) => tool.name),
    [
      "search_manual",
      "get_manual_entry",
      "list_manual_sections",
      "get_manual_build",
      "list_script_targets",
      "validate_script",
      "inspect_symbol",
      "complete_at",
    ],
  );
  assert.ok(listed.tools.some((tool) => tool.name === "debug_start"));
  assert.equal(
    listed.tools.find((tool) => tool.name === "run_script")?.annotations?.readOnlyHint,
    false,
  );
  assert.equal(
    listed.tools.find((tool) => tool.name === "find_references")?.annotations?.readOnlyHint,
    true,
  );

  const searched = await client.callTool({
    name: "search_manual",
    arguments: { query: "vehicle charging station" },
  });
  assert.equal(searched.isError, undefined);
  assert.equal(at(searched, "structuredContent", "resultCount"), 1);
  assert.equal(at(searched, "structuredContent", "results", 0, "id"), 0);

  const fetched = await client.callTool({
    name: "get_manual_entry",
    arguments: { identifier: 0 },
  });
  assert.equal(at(fetched, "structuredContent", "entry", "title"), "Batteries & Charging");
  assert.match(z.string().parse(at(fetched, "content", 0, "text")), /self\.charge\(\)/);
  assert.match(
    z.string().parse(at(fetched, "structuredContent", "entry", "markdown")),
    /self\.charge\(\)/,
  );

  const sections = await client.callTool({ name: "list_manual_sections", arguments: {} });
  assert.equal(at(sections, "structuredContent", "entryCount"), 3);

  const build = await client.callTool({ name: "get_manual_build", arguments: {} });
  assert.equal(at(build, "structuredContent", "build"), "test-build-42");

  const targets = await client.callTool({
    name: "list_script_targets",
    arguments: { ownerType: "pioneer" },
  });
  assert.equal(at(targets, "structuredContent", "resultCount"), 1);
  assert.equal(at(targets, "structuredContent", "targets", 0, "id"), "pioneer_1");

  const validated = await client.callTool({
    name: "validate_script",
    arguments: { target: "pioneer_1", source: "self.nope()" },
  });
  assert.equal(at(validated, "structuredContent", "valid"), false);
  assert.equal(at(validated, "structuredContent", "diagnosticCount"), 1);

  const inspected = await client.callTool({
    name: "inspect_symbol",
    arguments: { target: "pioneer_1", source: "self", line: 1, column: 1 },
  });
  assert.equal(at(inspected, "structuredContent", "hover", "contents"), "Pioneer owner");

  const completed = await client.callTool({
    name: "complete_at",
    arguments: { target: "pioneer_1", source: "self.", line: 1, column: 6 },
  });
  assert.equal(at(completed, "structuredContent", "items", 0, "label"), "battery");

  const status = await client.callTool({ name: "get_game_status", arguments: {} });
  assert.equal(at(status, "structuredContent", "data", "byStatus", "running"), 1);
  const refs = await client.callTool({
    name: "find_references",
    arguments: { target: "pioneer_1", source: "helper", line: 1, column: 5 },
  });
  assert.equal(
    at(refs, "structuredContent", "data", "references", 0, "range", "start", "column"),
    5,
  );
  const run = await client.callTool({ name: "run_script", arguments: { target: "pioneer_1" } });
  assert.equal(at(run, "structuredContent", "data", "ok"), true);
  const applied = await client.callTool({
    name: "apply_library",
    arguments: { target: "helpers" },
  });
  assert.equal(at(applied, "structuredContent", "data", "ok"), true);
  const appliedAll = await client.callTool({ name: "apply_all_libraries", arguments: {} });
  assert.equal(at(appliedAll, "structuredContent", "data", "ok"), true);
  assert.deepEqual(gameCommands.slice(-2), [
    { command: "codeTerraform.applyLibrary", target: "helpers", kind: "library" },
    { command: "codeTerraform.applyAllLibraries" },
  ]);
  const automations = await client.callTool({
    name: "list_fleet",
    arguments: { kind: "automations" },
  });
  assert.deepEqual(at(automations, "structuredContent", "data", "items"), []);
});
