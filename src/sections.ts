import { entryMarkdown, normalizeSearchText, scanHeadings } from "./parser.js";

import type { BodyHeading, ManualEntry } from "./parser.js";

// Error messages list at most this many headings; the largest entries have hundreds.
const MAX_LISTED_CHOICES = 30;

export interface OutlineItem {
  heading: string;
  level: number;
  /** Nesting depth from 0; the manual skips heading levels (### then #####), so depth != level - 3. */
  depth: number;
  /** One-based line of the heading in the manual source. */
  sourceLine: number;
  /** Characters in the section, including its subsections. */
  characters: number;
}

export interface EntrySection {
  heading: string;
  level: number;
  /** Enclosing headings, outermost first. */
  path: string[];
  /** One-based source line of the heading. */
  sourceLineStart: number;
  /** One-based source line of the section's last line. */
  sourceLineEnd: number;
  /** Hierarchy marker, entry heading, enclosing heading lines, then the section. */
  markdown: string;
}

// A section runs to the next heading of the same or a higher level, so it keeps its subsections.
function sectionEnd(headings: BodyHeading[], index: number, lineCount: number) {
  const start = headings[index]!;
  const next = headings.find((heading, other) => other > index && heading.level <= start.level);
  return next?.line ?? lineCount;
}

/** The entry's headings with source lines and section sizes, without any body text. */
export function entryOutline(entry: ManualEntry): OutlineItem[] {
  const lines = entry.body.split("\n");
  const headings = scanHeadings(entry.body);
  const open: number[] = [];
  return headings.map((heading, index) => {
    while (open.length > 0 && open.at(-1)! >= heading.level) open.pop();
    const depth = open.length;
    open.push(heading.level);
    const section = lines.slice(heading.line, sectionEnd(headings, index, lines.length));
    return {
      heading: heading.text,
      level: heading.level,
      depth,
      sourceLine: entry.bodyLineStart + heading.line,
      characters: section.join("\n").length,
    };
  });
}

/**
 * One heading's section of an entry. Matches the heading text case- and punctuation-insensitively:
 * an exact match wins, then a match on the heading's leading words, then a partial match. Ambiguous
 * and missing headings throw with the choices, so a caller can retry with the exact text.
 */
export function resolveSection(entry: ManualEntry, heading: string): EntrySection {
  const wanted = normalizeSearchText(heading);
  if (!wanted) throw new Error("Heading must contain at least one letter or number.");

  const lines = entry.body.split("\n");
  const headings = scanHeadings(entry.body);
  if (headings.length === 0) {
    throw new Error(`Entry ${entry.id} (${entry.title}) has no headings; read the whole entry.`);
  }
  const normalized = headings.map((item) => normalizeSearchText(item.text));
  // Tiers, first non-empty wins: exact text, leading words (a method name picks its signature
  // heading), then anywhere in the heading.
  const tiers = [
    (text: string) => text === wanted,
    (text: string) => text.startsWith(`${wanted} `),
    (text: string) => text.includes(wanted),
  ];
  let matches: number[] = [];
  for (const tier of tiers) {
    matches = normalized.flatMap((text, index) => (tier(text) ? [index] : []));
    if (matches.length > 0) break;
  }
  if (matches.length !== 1) {
    const listed = matches.length > 1 ? matches : headings.map((_, index) => index);
    const choices = listed
      .slice(0, MAX_LISTED_CHOICES)
      .map((index) => `"${headings[index]!.text}"`)
      .join(", ");
    const more =
      listed.length > MAX_LISTED_CHOICES
        ? `, and ${listed.length - MAX_LISTED_CHOICES} more (outline: true lists all)`
        : "";
    throw new Error(
      matches.length > 1
        ? `Heading '${heading}' is ambiguous in entry ${entry.id}. Use one of: ${choices}${more}`
        : `Entry ${entry.id} (${entry.title}) has no heading matching '${heading}'. Headings: ${choices}${more}`,
    );
  }

  const index = matches[0]!;
  const match = headings[index]!;
  let end = sectionEnd(headings, index, lines.length);
  while (end > match.line + 1 && lines[end - 1]!.trim() === "") end -= 1;
  // Enclosing headings: walking back, each one with a lower level than the last one kept.
  const ancestors: BodyHeading[] = [];
  let level = match.level;
  for (let other = index - 1; other >= 0; other -= 1) {
    const candidate = headings[other]!;
    if (candidate.level < level) {
      ancestors.unshift(candidate);
      level = candidate.level;
    }
  }
  const body = [
    ...ancestors.map((ancestor) => lines[ancestor.line]!),
    lines.slice(match.line, end).join("\n"),
  ].join("\n\n");

  return {
    heading: match.text,
    level: match.level,
    path: ancestors.map((ancestor) => ancestor.text),
    sourceLineStart: entry.bodyLineStart + match.line,
    sourceLineEnd: entry.bodyLineStart + end - 1,
    markdown: entryMarkdown(entry.hierarchy, entry.rawTitle, body),
  };
}
