import { MiniGFM } from "@oblivionocean/minigfm";

const md = new MiniGFM();

const FACTORY_MARKDOWN_SECTION_HEADINGS = new Set([
  "conclusion",
  "evidence",
  "disagreements",
  "scripts run",
  "artifacts",
  "next steps",
  "next best action",
  "what's happening",
  "current signal",
  "blockers",
  "what i found",
  "why it matters",
  "scope",
  "next",
]);

const FACTORY_MARKDOWN_LIST_MARKER_RE = /^([-*+]|\d+[.)])\s+/;

const nextMeaningfulMarkdownLine = (
  lines: ReadonlyArray<string>,
  startIndex: number,
): string | undefined => {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

const isMarkdownListLine = (value: string): boolean => FACTORY_MARKDOWN_LIST_MARKER_RE.test(value);

const isLikelyMarkdownSectionHeading = (value: string): boolean => {
  const heading = value.replace(/:\s*$/, "").trim();
  const withoutParens = heading.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!heading || !withoutParens) return false;
  if (heading.length > 72) return false;
  if (!/^[A-Z0-9]/.test(heading)) return false;
  if (/[.!?;|]/.test(heading)) return false;
  const words = withoutParens.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 7;
};

const normalizeMarkdownHeadingDepth = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (/^#\s+/.test(line)) return line.replace(/^#(\s+)/, "##$1");
    return line.replace(/^(#{5,})(\s+)/, "####$2");
  }).join("\n");
};

const normalizeMarkdownSectionHeadings = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (
      inFence
      || !trimmed
      || trimmed.startsWith("#")
      || trimmed.startsWith("- ")
      || trimmed.includes("|")
      || /^\d+[.)]\s+/.test(trimmed)
    ) {
      return line;
    }
    const heading = trimmed.replace(/:\s*$/, "");
    const nextMeaningful = nextMeaningfulMarkdownLine(lines, index);
    const prevTrimmed = index > 0 ? lines[index - 1]?.trim() ?? "" : "";
    const nextTrimmed = index + 1 < lines.length ? lines[index + 1]?.trim() ?? "" : "";
    const isStandalone = (!prevTrimmed || index === 0) && (!nextTrimmed || index === lines.length - 1);
    const isLeadInBeforeList = trimmed.endsWith(":") && Boolean(nextMeaningful && isMarkdownListLine(nextMeaningful));
    return FACTORY_MARKDOWN_SECTION_HEADINGS.has(heading.toLowerCase())
      || (isStandalone && !isLeadInBeforeList && isLikelyMarkdownSectionHeading(trimmed))
      ? `## ${heading}`
      : line;
  }).join("\n");
};

const normalizeMarkdownLeadIns = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (
      inFence
      || !trimmed
      || trimmed.startsWith("#")
      || trimmed.startsWith("- ")
      || trimmed.includes("|")
      || /^\d+[.)]\s+/.test(trimmed)
      || !trimmed.endsWith(":")
    ) {
      return line;
    }
    const label = trimmed.replace(/:\s*$/, "");
    const nextMeaningful = nextMeaningfulMarkdownLine(lines, index);
    const words = label.split(/\s+/).filter(Boolean);
    if (
      FACTORY_MARKDOWN_SECTION_HEADINGS.has(label.toLowerCase())
      || !nextMeaningful
      || !isMarkdownListLine(nextMeaningful)
      || words.length === 0
      || words.length > 5
      || label.length > 48
    ) {
      return line;
    }
    return `**${label}:**`;
  }).join("\n");
};

const normalizeInlineNumberedLists = (value: string): string => {
  const lines = value.split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      return line;
    }
    if (inFence || line.includes("|")) return line;
    const markers = [...line.matchAll(/(?:^|\s)(\d+)\)\s+/g)];
    if (markers.length < 2) return line;
    const firstMarker = markers[0];
    if (!firstMarker || typeof firstMarker.index !== "number") return line;
    const prefix = line.slice(0, firstMarker.index).trimEnd();
    const numbered = line.slice(firstMarker.index);
    const items = [...numbered.matchAll(/\d+\)\s*([^]+?)(?=(?:\s+\d+\)\s)|$)/g)]
      .map((match) => match[1]?.trim())
      .filter((item): item is string => Boolean(item));
    if (items.length === 0) return line;
    const list = items.map((item) => `- ${item}`).join("\n");
    return prefix ? `${prefix}\n\n${list}` : list;
  }).join("\n");
};

export const normalizeMarkdownForDisplay = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return normalizeMarkdownHeadingDepth(
    normalizeInlineNumberedLists(
      normalizeMarkdownLeadIns(
        normalizeMarkdownSectionHeadings(trimmed),
      ),
    ),
  );
};

export const renderMarkdown = (raw: string): string => {
  const text = normalizeMarkdownForDisplay(raw);
  if (!text) return `<p class="text-sm text-muted-foreground">Waiting for a response.</p>`;
  return md.parse(text);
};
