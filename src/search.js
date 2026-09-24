import { normalizeSearchText, slugify } from "./parser.js";

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

function occurrences(haystack, needle, cap = 5) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (count < cap) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + Math.max(needle.length, 1);
  }
  return count;
}

function scoreEntry(entry, phrase, tokens) {
  let score = 0;

  if (entry.search.title === phrase) score += 180;
  else if (entry.search.title.includes(phrase)) score += 90;
  if (entry.search.hierarchy.includes(phrase)) score += 45;
  if (entry.search.terms.includes(phrase)) score += 55;
  if (entry.search.headings.includes(phrase)) score += 40;
  if (entry.search.body.includes(phrase)) score += 30;

  for (const token of tokens) {
    if (entry.search.title.split(" ").includes(token)) score += 28;
    else if (entry.search.title.includes(token)) score += 16;
    if (entry.search.hierarchy.includes(token)) score += 8;
    if (entry.search.terms.includes(token)) score += 14;
    if (entry.search.headings.includes(token)) score += 10;
    score += occurrences(entry.search.body, token) * 2;
  }

  return score;
}

function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, " "))
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_#>|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetFor(entry, phrase, tokens) {
  const text = plainText(entry.body);
  const lower = text.toLowerCase();
  const candidates = [phrase, ...tokens].filter(Boolean);
  let index = -1;
  for (const candidate of candidates) {
    index = lower.indexOf(candidate.toLowerCase());
    if (index !== -1) break;
  }
  if (index === -1) index = 0;

  const radius = 170;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function searchManual(manual, query, options = {}) {
  const phrase = normalizeSearchText(query);
  if (!phrase) throw new Error("Search query must contain at least one letter or number.");

  const tokens = [...new Set(phrase.split(" ").filter(Boolean))];
  const sectionFilter = options.section ? normalizeSearchText(options.section) : "";
  const requestedLimit = Number.isInteger(options.limit) ? options.limit : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);

  return manual.entries
    .filter((entry) => !sectionFilter || entry.search.hierarchy.includes(sectionFilter))
    .map((entry) => ({ entry, score: scoreEntry(entry, phrase, tokens) }))
    .filter(({ entry, score }) => score > 0 && tokens.every((token) => (
      entry.search.title.includes(token) ||
      entry.search.hierarchy.includes(token) ||
      entry.search.headings.includes(token) ||
      entry.search.terms.includes(token) ||
      entry.search.body.includes(token)
    )))
    .sort((left, right) => right.score - left.score || left.entry.id - right.entry.id)
    .slice(0, limit)
    .map(({ entry, score }) => ({
      id: entry.id,
      title: entry.title,
      badge: entry.badge,
      section: entry.section,
      group: entry.group,
      url: entry.url,
      score,
      snippet: snippetFor(entry, phrase, tokens)
    }));
}

export function resolveEntry(manual, identifier) {
  const raw = String(identifier).trim();
  if (!raw) throw new Error("Entry identifier cannot be empty.");

  if (/^\d+$/.test(raw)) {
    const byId = manual.entries.find((entry) => entry.id === Number(raw));
    if (byId) return byId;
  }

  const normalized = normalizeSearchText(raw);
  const matches = manual.entries.filter((entry) => (
    entry.url === raw ||
    entry.search.title === normalized ||
    slugify(entry.title) === raw.toLowerCase()
  ));

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const choices = matches.map((entry) => `${entry.id}: ${entry.hierarchy} / ${entry.title}`).join("; ");
    throw new Error(`Entry identifier is ambiguous. Use a numeric ID: ${choices}`);
  }

  throw new Error(`No manual entry matches '${raw}'. Use search_manual to find an entry ID.`);
}

export function listSections(manual) {
  const sections = new Map();
  for (const entry of manual.entries) {
    if (!sections.has(entry.section)) sections.set(entry.section, new Map());
    const groups = sections.get(entry.section);
    const groupName = entry.group || entry.section;
    groups.set(groupName, (groups.get(groupName) ?? 0) + 1);
  }

  return [...sections].map(([name, groups]) => ({
    name,
    entryCount: [...groups.values()].reduce((sum, count) => sum + count, 0),
    groups: [...groups].map(([groupName, entryCount]) => ({ name: groupName, entryCount }))
  }));
}
