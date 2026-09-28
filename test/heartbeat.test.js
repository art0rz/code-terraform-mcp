import assert from "node:assert/strict";
import test from "node:test";
import { Heartbeat } from "../src/heartbeat.js";

test("heartbeat coalesces overlapping checks and reports recovery", async () => {
  const messages = [];
  let calls = 0;
  let release;
  const heartbeat = new Heartbeat(async () => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    if (calls === 2) throw new Error("LSP unavailable");
    return "LSP responsive.";
  }, { log: { info: (message) => messages.push(message), warn: (message) => messages.push(message) } });

  const first = heartbeat.check();
  const overlapping = heartbeat.check();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, overlapping]);
  await heartbeat.check();
  await heartbeat.check();

  assert.deepEqual(messages, [
    "Heartbeat: LSP responsive.",
    "Heartbeat failed: LSP unavailable",
    "Heartbeat: LSP responsive."
  ]);
});
