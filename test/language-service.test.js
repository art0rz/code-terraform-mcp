import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LanguageService } from "../src/language-service.js";
import { WorkspaceStore } from "../src/workspace-store.js";

const fixtureServer = fileURLToPath(new URL("../fake-lsp.cjs", import.meta.url));

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-terraform-lsp-"));
  await writeFile(path.join(root, "pioneer_1.py"), "print('live source')\n");
  await writeFile(path.join(root, "codeterraform-workspace.json"), JSON.stringify({
    analysisVersion: "test-analysis",
    saveId: "save_test",
    server: { path: fixtureServer, analysisVersion: "test-analysis" },
    context: { machines: { pioneer_1: { typeId: "pioneer" } } },
    documents: [{ path: "pioneer_1.py", id: "pioneer_1", kind: "script" }]
  }));
  return root;
}

test("language service validates, inspects, and completes in memory", async (context) => {
  const root = await createWorkspace();
  const store = new WorkspaceStore(root);
  const service = new LanguageService(store, { timeoutMs: 5_000 });
  context.after(() => service.dispose());

  const invalid = await service.validate("pioneer_1", "broken()", 5_000);
  assert.equal(invalid.document.ownerType, "pioneer");
  assert.equal(invalid.diagnostics[0].message, "Fake broken source");
  assert.deepEqual(invalid.diagnostics[0].range.start, { line: 1, column: 1 });

  const inspected = await service.inspect("pioneer_1", "self.move_to(1, 2)", { line: 1, column: 7 });
  assert.equal(inspected.hover.contents, "**Fake owner**");
  assert.equal(inspected.signature.signatures[0].label, "move_to(x, y)");

  const completed = await service.complete("pioneer_1", "self.", { line: 1, column: 6 }, "move", 10);
  assert.deepEqual(completed.items.map((item) => item.label), ["move_to"]);

  const symbols = await service.documentRequest("pioneer_1", "def helper():\n pass\n", "textDocument/documentSymbol");
  assert.equal(symbols.result[0].name, "helper");
  const references = await service.documentRequest("pioneer_1", "helper()\n", "textDocument/references", {
    position: { line: 0, character: 5 }, context: { includeDeclaration: true }
  });
  assert.equal(references.result.length, 1);
  const command = await service.gameCommand("codeTerraform.run", "pioneer_1", { kind: "script" });
  assert.deepEqual(command.result, { ok: true, action: "codeTerraform.run" });
  const overview = await service.gameOverview();
  assert.equal(overview.status.ready, true);
  assert.equal(overview.fleet.scripts.pioneer_1.status, "running");
  await assert.rejects(() => service.gameCommand("codeTerraform.run", "../secret.py", { kind: "script" }), /Unknown script target/);

  assert.equal(await (await import("node:fs/promises")).readFile(path.join(root, "pioneer_1.py"), "utf8"), "print('live source')\n");
});

test("workspace store rejects unregistered and escaping targets", async () => {
  const root = await createWorkspace();
  const store = new WorkspaceStore(root);
  await assert.rejects(() => store.resolveTarget("../secret.py"), /Unknown script target/);

  await writeFile(path.join(root, "codeterraform-workspace.json"), JSON.stringify({
    server: { path: fixtureServer, analysisVersion: "test-analysis" },
    documents: [{ path: "../secret.py", id: "secret", kind: "script" }]
  }));
  await assert.rejects(() => store.load(), /escapes the workspace/);
});

test("language server failure cannot become a clean validation", async (context) => {
  const root = await createWorkspace();
  const service = new LanguageService(new WorkspaceStore(root), { timeoutMs: 2_000 });
  context.after(() => service.dispose());
  await assert.rejects(() => service.validate("pioneer_1", "killserver()", 2_000), /language server exited/);
});

test("state-changing targets cannot follow a registered symlink outside the workspace", async () => {
  const root = await createWorkspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), "code-terraform-outside-"));
  await writeFile(path.join(outside, "external.py"), "pass\n");
  await symlink(path.join(outside, "external.py"), path.join(root, "linked.py"));
  await writeFile(path.join(root, "codeterraform-workspace.json"), JSON.stringify({
    analysisVersion: "test-analysis", server: { path: fixtureServer, analysisVersion: "test-analysis" },
    documents: [{ path: "linked.py", id: "linked", kind: "script" }]
  }));
  const store = new WorkspaceStore(root);
  const { workspace, document } = await store.resolveTarget("linked");
  await assert.rejects(() => store.verifyDocumentFile(workspace, document), /outside the workspace/);
});
