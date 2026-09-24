import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSearchText, parseManual, slugify } from "../src/parser.js";
import { sampleManual } from "./fixtures.js";

test("parseManual extracts build, hierarchy, badges, content, and lines", () => {
  const manual = parseManual(sampleManual, "/tmp/manual.md");

  assert.equal(manual.build, "test-build-42");
  assert.equal(manual.entryCount, 3);
  assert.equal(manual.entries[0].title, "Batteries & Charging");
  assert.equal(manual.entries[0].section, "Guide");
  assert.equal(manual.entries[0].group, "Basics");
  assert.deepEqual(manual.entries[0].headings, ["Charging safely"]);
  assert.ok(manual.entries[0].inlineTerms.includes("self.charge()"));
  assert.equal(manual.entries[1].badge, "Component");
  assert.match(manual.entries[1].markdown, /^\*Components \/ Power\*/);
  assert.ok(manual.entries[0].sourceLineStart < manual.entries[0].sourceLineEnd);
});

test("parseManual rejects malformed input", () => {
  assert.throws(() => parseManual("# No entries\n\nBuild x"), /No manual entries/);
  assert.throws(() => parseManual(""), /empty/);
});

test("normalization supports symbols, punctuation, and camel case", () => {
  assert.equal(slugify("Batteries & Charging"), "batteries-and-charging");
  assert.equal(normalizeSearchText("self.getCharge()"), "self get charge");
});
