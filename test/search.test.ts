import assert from "node:assert/strict";
import test from "node:test";
import { parseManual } from "../src/parser.js";
import { listSections, resolveEntry, searchManual } from "../src/search.js";
import { sampleManual } from "./fixtures.js";

const manual = parseManual(sampleManual);

void test("searchManual ranks focused results and returns snippets", () => {
  const results = searchManual(manual, "vehicle charging station");
  assert.equal(results[0]!.id, 0);
  assert.match(results[0]!.snippet, /vehicle charging station/i);
  assert.ok(results[0]!.score > 0);
});

void test("searchManual searches inline API symbols and filters sections", () => {
  const results = searchManual(manual, "self charge", { section: "Components", limit: 3 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.section, "Components");
});

void test("resolveEntry supports IDs and reports ambiguous titles", () => {
  assert.equal(resolveEntry(manual, 0).title, "Batteries & Charging");
  assert.equal(resolveEntry(manual, "/generated/components/power/battery").badge, "Component");
  assert.throws(() => resolveEntry(manual, "Battery"), /ambiguous/);
  assert.throws(() => resolveEntry(manual, "missing"), /No manual entry/);
});

void test("listSections preserves manual order and counts groups", () => {
  const sections = listSections(manual);
  assert.deepEqual(
    sections.map((section) => section.name),
    ["Guide", "Components", "Types"],
  );
  assert.equal(sections[0]!.groups[0]!.name, "Basics");
  assert.equal(sections[0]!.entryCount, 1);
});
