import assert from "node:assert/strict";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DebugService } from "../src/debug-service.js";
import { WorkspaceStore } from "../src/workspace-store.js";

const fixture = fileURLToPath(new URL("../fake-debug-adapter.cjs", import.meta.url));

test("debug service launches, inspects, controls, and detaches through DAP", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-terraform-dap-"));
  const server = path.join(root, "server.cjs");
  await writeFile(server, "");
  await copyFile(fixture, path.join(root, "debug-adapter.cjs"));
  await writeFile(path.join(root, "pioneer_1.py"), "x = 3\n");
  await writeFile(path.join(root, "codeterraform-workspace.json"), JSON.stringify({
    analysisVersion: "test", server: { path: server, analysisVersion: "test" },
    documents: [{ id: "pioneer_1", path: "pioneer_1.py", kind: "script" }]
  }));
  const service = new DebugService(new WorkspaceStore(root));
  context.after(() => service.dispose());
  const session = await service.start("pioneer_1", [{ line: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(session.eventsAfter().events.some((event) => event.event === "stopped"));
  assert.equal((await session.request("stackTrace", { threadId: 1 })).stackFrames[0].line, 3);
  assert.equal((await session.request("evaluate", { expression: "x" })).result, "3");
  assert.equal((await service.setBreakpoints(session.id, "pioneer_1", [{ line: 2 }])).breakpoints[0].line, 2);
  await service.end(session.id);
  assert.equal(service.sessions.size, 0);
});
