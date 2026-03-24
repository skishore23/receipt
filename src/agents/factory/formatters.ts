import { asObject } from "./shared";

const clipText = (value: string, max = 180): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export const tryParseJson = (value: string): Record<string, unknown> | undefined => {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
};

export const humanizeKey = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());

const formatJsonScalar = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

export const compactJsonValue = (value: unknown): string | undefined => {
  const scalar = formatJsonScalar(value);
  if (scalar) return clipText(scalar, 220);
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => formatJsonScalar(entry) ?? compactJsonValue(asObject(entry)))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 6);
    return items.length > 0 ? clipText(items.join("; "), 220) : undefined;
  }
  const record = asObject(value);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .map(([key, entryValue]) => {
      const rendered = formatJsonScalar(entryValue)
        ?? (Array.isArray(entryValue)
          ? compactJsonValue(entryValue)
          : compactJsonValue(asObject(entryValue)));
      return rendered ? `${humanizeKey(key)}: ${rendered}` : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 6);
  return entries.length > 0 ? clipText(entries.join("; "), 220) : undefined;
};

const markdownTableCell = (value: unknown): string | undefined => {
  const rendered = formatJsonScalar(value)
    ?? (Array.isArray(value)
      ? compactJsonValue(value)
      : compactJsonValue(asObject(value)));
  return rendered
    ? rendered.replace(/\|/g, "\\|").replace(/\r?\n+/g, " <br> ")
    : undefined;
};

const jsonArrayToMarkdownTable = (value: ReadonlyArray<unknown>): string | undefined => {
  const rows = value
    .map(asObject)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (rows.length === 0 || rows.length !== value.length) return undefined;

  const orderedKeys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!orderedKeys.includes(key)) orderedKeys.push(key);
    }
  }

  const columns = orderedKeys
    .filter((key) => rows.some((row) => markdownTableCell(row[key])))
    .filter((key) => rows.every((row) => row[key] == null || markdownTableCell(row[key]) !== undefined))
    .slice(0, 6);
  if (columns.length === 0) return undefined;

  const tableRows = rows
    .map((row) => columns.map((key) => markdownTableCell(row[key]) ?? ""))
    .filter((cells) => cells.some((cell) => cell.length > 0));
  if (tableRows.length === 0) return undefined;

  const previewRows = tableRows.slice(0, 8);
  const header = `| ${columns.map((key) => humanizeKey(key)).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = previewRows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
  const note = tableRows.length > previewRows.length
    ? `\n\n_Showing ${previewRows.length} of ${tableRows.length} rows._`
    : "";
  return `${header}\n${divider}\n${body}${note}`;
};

export const jsonRecordToMarkdown = (record: Record<string, unknown>): string | undefined => {
  const sections = Object.entries(record)
    .flatMap(([key, value]) => {
      const heading = `## ${humanizeKey(key)}`;
      const scalar = formatJsonScalar(value);
      if (scalar) return [`${heading}\n${scalar}`];
      if (Array.isArray(value)) {
        const table = jsonArrayToMarkdownTable(value);
        if (table) {
          const countLine = `${value.length} item${value.length === 1 ? "" : "s"}.\n\n`;
          return [`${heading}\n${countLine}${table}`];
        }
        const items = value
          .map((entry) => formatJsonScalar(entry)
            ?? (Array.isArray(entry)
              ? compactJsonValue(entry)
              : compactJsonValue(asObject(entry))))
          .filter((entry): entry is string => Boolean(entry))
          .slice(0, 8);
        return items.length > 0 ? [`${heading}\n${items.map((entry) => `- ${entry}`).join("\n")}`] : [];
      }
      const nested = asObject(value);
      if (!nested) return [];
      const lines = Object.entries(nested)
        .map(([nestedKey, nestedValue]) => {
          const rendered = formatJsonScalar(nestedValue)
            ?? (Array.isArray(nestedValue)
              ? compactJsonValue(nestedValue)
              : compactJsonValue(asObject(nestedValue)));
          return rendered ? `- ${humanizeKey(nestedKey)}: ${rendered}` : undefined;
        })
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 8);
      return lines.length > 0 ? [`${heading}\n${lines.join("\n")}`] : [];
    })
    .filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : undefined;
};

export const buildDetail = (...chunks: ReadonlyArray<string | undefined>): string | undefined => {
  const detail = chunks
    .map((chunk) => chunk?.trim())
    .filter((chunk): chunk is string => Boolean(chunk))
    .join("\n\n");
  return detail || undefined;
};

export const truncateInline = (value: string, max = 220): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max
    ? `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`
    : normalized;
};
