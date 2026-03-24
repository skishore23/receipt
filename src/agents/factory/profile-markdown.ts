export type FactoryProfileSectionView = {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
};

const clipProfileText = (value: string, max = 180): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export const describeProfileMarkdown = (value: string): {
  readonly summary?: string;
  readonly sections: ReadonlyArray<FactoryProfileSectionView>;
} => {
  const withoutFrontmatter = value.replace(/^---[\s\S]*?---\s*/, "");
  const lines = withoutFrontmatter.split(/\r?\n/).map((line) => line.trim());
  let summary: string | undefined;
  const sections: FactoryProfileSectionView[] = [];
  let currentSection: { title: string; items: string[] } | undefined;
  const flushSection = (): void => {
    if (!currentSection || currentSection.items.length === 0) return;
    sections.push({
      title: currentSection.title,
      items: currentSection.items.slice(0, 4),
    });
  };
  for (const line of lines) {
    if (!line || line.startsWith("```")) continue;
    if (line.startsWith("## ")) {
      flushSection();
      currentSection = { title: line.slice(3).trim(), items: [] };
      continue;
    }
    if (!summary && !line.startsWith("#") && !line.startsWith("-")) {
      summary = clipProfileText(line);
      continue;
    }
    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (!item) continue;
      if (!currentSection) currentSection = { title: "How I Work", items: [] };
      currentSection.items.push(item);
    }
  }
  flushSection();
  return {
    summary,
    sections: sections.slice(0, 3),
  };
};
