import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sampleManual } from "./fixtures.js";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const relay = fileURLToPath(new URL("../dist/stdio-proxy.py", import.meta.url));

void test("compiled CLI exposes help without loading a manual", async () => {
  const { stdout, stderr } = await promisify(execFile)("python3", [
    relay,
    process.execPath,
    cli,
    "--help",
  ]);
  assert.match(stdout, /Usage:/);
  assert.equal(stderr, "");
});

void test("compiled server and bundled relay support an MCP handshake", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-terraform-cli-"));
  const manual = path.join(directory, "manual.md");
  await writeFile(manual, sampleManual);
  const transport = new StdioClientTransport({
    command: "python3",
    args: [relay, process.execPath, cli, "--manual", manual],
    cwd: directory,
    stderr: "pipe",
  });
  const client = new Client({ name: "compiled-cli-test", version: "1.0.0" });
  context.after(() => client.close());
  // After hooks run in registration order; Windows cannot remove the server's cwd while it runs.
  context.after(() => rm(directory, { recursive: true, force: true }));
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "search_manual"));
  const result = await client.callTool({ name: "get_manual_build", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    result.structuredContent &&
      typeof result.structuredContent === "object" &&
      "build" in result.structuredContent
      ? result.structuredContent.build
      : undefined,
    "test-build-42",
  );
});
