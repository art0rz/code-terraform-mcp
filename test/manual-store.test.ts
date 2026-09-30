import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MANUAL_PATH, ManualStore } from "../src/manual-store.js";
import { sampleManual } from "./fixtures.js";

void test("ManualStore loads a manual and exposes file metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-terraform-docs-mcp-test-"));
  const manualPath = path.join(directory, "manual.md");
  await writeFile(manualPath, sampleManual);

  const store = new ManualStore(manualPath);
  const manual = await store.load();

  assert.equal(manual.build, "test-build-42");
  assert.equal(manual.entryCount, 3);
  assert.equal(manual.sourcePath, manualPath);
  assert.ok(manual.byteSize > 0);
  assert.match(manual.loadedAt, /^\d{4}-\d{2}-\d{2}T/);
});

void test("default manual path is resolved from the process working directory", () => {
  assert.equal(DEFAULT_MANUAL_PATH, path.resolve(process.cwd(), "Code-Terraform-DOCS-Manual.md"));
  assert.equal(new ManualStore().manualPath, DEFAULT_MANUAL_PATH);
});

void test("ManualStore gives an actionable missing-file error", async () => {
  const store = new ManualStore("/tmp/definitely-not-a-code-terraform-manual.md");
  await assert.rejects(
    store.load(),
    /Place Code-Terraform-DOCS-Manual\.md in the working directory/,
  );
});
