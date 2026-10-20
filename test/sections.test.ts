import assert from "node:assert/strict";
import test from "node:test";
import { parseManual } from "../src/parser.js";
import { entryOutline, resolveSection } from "../src/sections.js";
import { sampleManual } from "./fixtures.js";

const manual = parseManual(sampleManual);
const battery = manual.entries[1]!;
const sourceLines = sampleManual.split("\n");

void test("entryOutline lists headings with levels, source lines, and nested sizes", () => {
  const outline = entryOutline(battery);
  assert.deepEqual(
    outline.map((item) => [item.heading, item.level, item.depth]),
    [
      ["Properties", 3, 0],
      ["charge: float", 5, 1],
      ["capacity: float", 5, 1],
      ["Methods", 3, 0],
      ["discharge(amount: float)", 5, 1],
    ],
  );
  for (const item of outline) {
    assert.match(sourceLines[item.sourceLine - 1]!, /^#{3,6} /);
  }
  const [properties, charge, capacity] = outline;
  assert.ok(properties!.characters > charge!.characters + capacity!.characters);
  assert.deepEqual(entryOutline(manual.entries[2]!), []);
});

void test("resolveSection returns one section with its subsections and enclosing headings", () => {
  const properties = resolveSection(battery, "properties");
  assert.equal(properties.heading, "Properties");
  assert.deepEqual(properties.path, []);
  assert.match(properties.markdown, /^\*Components \/ Power\*\n\n## Battery \*\(Component\)\*/);
  assert.match(properties.markdown, /capacity: float/);
  assert.doesNotMatch(properties.markdown, /discharge/);
  assert.match(sourceLines[properties.sourceLineStart - 1]!, /^### Properties/);
  assert.equal(sourceLines[properties.sourceLineEnd - 1], "Maximum stored energy.");

  const charge = resolveSection(battery, "`charge: float`");
  assert.deepEqual(charge.path, ["Properties"]);
  assert.match(charge.markdown, /### Properties\n\n##### `charge: float`/);
  assert.match(charge.markdown, /not a heading inside a fence/);
  assert.doesNotMatch(charge.markdown, /capacity/);
});

void test("resolveSection prefers exact text, then leading words, then a partial match", () => {
  assert.equal(resolveSection(battery, "METHODS").heading, "Methods");
  // "charge" is inside "discharge(...)" too; the leading-word match picks the property.
  assert.equal(resolveSection(battery, "charge").heading, "charge: float");
  assert.equal(resolveSection(battery, "amount").heading, "discharge(amount: float)");
  assert.throws(
    () => resolveSection(battery, "float"),
    /ambiguous.*"charge: float", "capacity: float", "discharge\(amount: float\)"/,
  );
  assert.throws(() => resolveSection(battery, "events"), /no heading matching 'events'.*"Methods"/);
  assert.throws(() => resolveSection(manual.entries[2]!, "anything"), /has no headings/);
  assert.throws(() => resolveSection(battery, "!!"), /letter or number/);
});
