import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../src/logger.js";

void test("logger filters levels and keeps each stderr record on one line", () => {
  const lines: string[] = [];
  const log = createLogger({ level: "warn", write: (line) => lines.push(line) });
  log.info("ordinary request");
  log.warn("adapter\nexited");
  log.error("startup failed");

  assert.equal(lines.length, 2);
  assert.match(
    lines[0]!,
    /^\d{4}-\d\d-\d\dT.* \[WARN\] code-terraform-docs-mcp: adapter exited\n$/,
  );
  assert.match(lines[1]!, /\[ERROR\] code-terraform-docs-mcp: startup failed\n$/);
});
