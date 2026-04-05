import { MiniGFM } from "@oblivionocean/minigfm";

const md = new MiniGFM();

export const normalizeMarkdownForDisplay = (raw: string): string => raw.trim();

export const renderMarkdown = (raw: string): string => {
  const text = normalizeMarkdownForDisplay(raw);
  if (!text) return `<p class="text-sm text-muted-foreground">Waiting for a response.</p>`;
  return md.parse(text);
};
