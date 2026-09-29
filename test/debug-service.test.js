import assert from "node:assert/strict";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DebugService } from "../src/debug-service.js";
import { WorkspaceStore } from "../src/workspace-store.js";

const fixture = fileURLToPath(new URL("../fake-debug-adapter.cjs", import.meta.url));

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-terraform-dap-"));
  const server = path.join(root, "server.cjs");
  await writeFile(server, "");
  await copyFile(fixture, path.join(root, "debug-adapter.cjs"));
  await writeFile(path.join(root, "pioneer_1.py"), "x = 3\n");
  await writeFile(path.join(root, "codeterraform-workspace.json"), JSON.stringify({
    analysisVersion: "test", server: { path: server, analysisVersion: "test" },
    documents: [{ id: "pioneer_1", path: "pioneer_1.py", kind: "script" }]
  }));
  return root;
}

function connectedVia(session) {
  const output = session.eventsAfter().events.find((event) => event.event === "output")?.body.output;
  return output?.replace("connected via ", "");
}

test("debug service launches, inspects, controls, and detaches through DAP", async (context) => {
  const service = new DebugService(new WorkspaceStore(await createWorkspace()));
  context.after(() => service.dispose());
  const session = await service.start("pioneer_1", [{ line: 1 }], { runIfIdle: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connectedVia(session), "launch");
  assert.ok(session.eventsAfter().events.some((event) => event.event === "stopped"));
  assert.equal((await session.request("stackTrace", { threadId: 1 })).stackFrames[0].line, 3);
  assert.equal((await session.request("evaluate", { expression: "x" })).result, "3");
  assert.equal((await service.setBreakpoints(session.id, "pioneer_1", [{ line: 2 }])).breakpoints[0].line, 2);
  await service.end(session.id);
  assert.equal(service.sessions.size, 0);
});

test("debug service attaches without starting an idle script by default", async (context) => {
  const service = new DebugService(new WorkspaceStore(await createWorkspace()));
  context.after(() => service.dispose());
  const session = await service.start("pioneer_1");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connectedVia(session), "attach");
  await service.end(session.id);
});
