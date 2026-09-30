const ENTRY_HEADING = /^## (?!Contents\s*$)/;
const HIERARCHY_MARKER = /^\*[^*]+\*$/;

export function slugify(value: string) {
  return (
    String(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "index"
  );
}

export function normalizeSearchText(value: string) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractBuild(markdown: string) {
  const match = markdown.match(/^Build\s+([^\s]+)\s*$/m);
  if (!match) {
    throw new Error("Could not find a 'Build <identifier>' line in the manual.");
  }
  return match[1]!;
}

function extractHeadings(body: string) {
  const headings = [];
  let fence: { character: string; length: number } | undefined;

  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = { character: marker[0]!, length: marker.length };
      } else if (marker[0]! === fence.character && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;

    const heading = line.match(/^#{3,6}\s+(.+?)\s*#*$/);
    if (heading) {
      headings.push(heading[1]!.replace(/[`*_]/g, "").trim());
    }
  }

  return headings;
}

function extractInlineTerms(body: string) {
  const terms = new Set<string>();
  for (const match of body.matchAll(/`([^`\n]{1,120})`/g)) {
    const value = match[1]!.trim();
    if (value) terms.add(value);
  }
  return [...terms];
}

function makeUrl(section: string, group: string, title: string, id: number, usedUrls: Set<string>) {
  const parts = [slugify(section)];
  if (group) parts.push(slugify(group));
  parts.push(slugify(title));
  let url = `/generated/${parts.join("/")}`;
  if (usedUrls.has(url)) url = `${url}-${id}`;
  if (usedUrls.has(url)) throw new Error(`Could not generate a unique URL for entry ${id}.`);
  usedUrls.add(url);
  return url;
}

export function parseManual(markdown: string, sourcePath = "manual.md") {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new Error("The manual is empty.");
  }

  const normalizedMarkdown = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalizedMarkdown.split("\n");
  const starts: { headingIndex: number; markerIndex: number }[] = [];

  for (let headingIndex = 0; headingIndex < lines.length; headingIndex += 1) {
    if (!ENTRY_HEADING.test(lines[headingIndex]!)) continue;

    let markerIndex = headingIndex - 1;
    while (markerIndex >= 0 && lines[markerIndex]!.trim() === "") markerIndex -= 1;
    if (!HIERARCHY_MARKER.test(lines[markerIndex] ?? "")) continue;
    starts.push({ headingIndex, markerIndex });
  }

  if (starts.length === 0) {
    throw new Error(
      "No manual entries were found. Expected '*Section / Group*' followed by an '## Entry' heading.",
    );
  }

  const usedUrls = new Set<string>();
  const entries = starts.map((start, id) => {
    const endIndex = starts[id + 1]?.markerIndex ?? lines.length;
    const rawTitle = lines[start.headingIndex]!.slice(3).trim();
    const badgeMatch = rawTitle.match(/\s+\*\(([^)]+)\)\*$/);
    const title = badgeMatch ? rawTitle.slice(0, badgeMatch.index).trim() : rawTitle;
    const badge = badgeMatch?.[1] ?? "";
    const hierarchy = lines[start.markerIndex]!.slice(1, -1).trim();
    const [section = "", ...groupParts] = hierarchy.split(" / ").map((part) => part.trim());
    const group = groupParts.join(" / ");
    const body = lines
      .slice(start.headingIndex + 1, endIndex)
      .join("\n")
      .trim();
    const headings = extractHeadings(body);
    const inlineTerms = extractInlineTerms(body);
    const url = makeUrl(section, group, title, id, usedUrls);

    return {
      id,
      title,
      badge,
      section,
      group,
      hierarchy,
      body,
      headings,
      inlineTerms,
      url,
      sourceLineStart: start.headingIndex + 1,
      sourceLineEnd: endIndex,
      markdown: [`*${hierarchy}*`, "", `## ${rawTitle}`, "", body].join("\n").trim(),
      search: {
        title: normalizeSearchText(title),
        hierarchy: normalizeSearchText(hierarchy),
        headings: normalizeSearchText(headings.join(" ")),
        terms: normalizeSearchText(inlineTerms.join(" ")),
        body: normalizeSearchText(body),
      },
    };
  });

  return {
    build: extractBuild(normalizedMarkdown),
    sourcePath,
    entryCount: entries.length,
    entries,
  };
}

export type Manual = ReturnType<typeof parseManual>;
export type ManualEntry = Manual["entries"][number];
