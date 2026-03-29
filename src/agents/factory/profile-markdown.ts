export type FactoryProfileSectionView = {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
};

type FactoryProfileOverviewInput = {
  readonly mdBody: string;
  readonly soulBody?: string;
  readonly roles?: ReadonlyArray<string>;
  readonly responsibilities?: ReadonlyArray<string>;
};

type FactoryProfileOverview = {
  readonly summary?: string;
  readonly soulSummary?: string;
  readonly profileSummary?: string;
  readonly sections: ReadonlyArray<FactoryProfileSectionView>;
  readonly primaryRole?: string;
  readonly roles: ReadonlyArray<string>;
  readonly responsibilities: ReadonlyArray<string>;
};

const clipProfileText = (value: string, max = 320): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const normalizedList = (items: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  (items ?? []).map((item) => item.trim()).filter(Boolean);

const firstMarkdownParagraph = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const lines = value.replace(/^---[\s\S]*?---\s*/, "").split(/\r?\n/).map((line) => line.trim());
  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("-") || line.startsWith("```")) continue;
    return clipProfileText(line);
  }
  return undefined;
};

export const describeProfileMarkdown = (value: string | FactoryProfileOverviewInput): FactoryProfileOverview => {
  const mdBody = typeof value === "string" ? value : value.mdBody;
  const soulBody = typeof value === "string" ? undefined : value.soulBody;
  const roles = typeof value === "string" ? [] : normalizedList(value.roles);
  const responsibilities = typeof value === "string" ? [] : normalizedList(value.responsibilities);
  const withoutFrontmatter = mdBody.replace(/^---[\s\S]*?---\s*/, "");
  const lines = withoutFrontmatter.split(/\r?\n/).map((line) => line.trim());
  let summary: string | undefined;
  const markdownSections: FactoryProfileSectionView[] = [];
  let currentSection: { title: string; items: string[] } | undefined;
  const flushSection = (): void => {
    if (!currentSection || currentSection.items.length === 0) return;
    markdownSections.push({
      title: currentSection.title,
      items: currentSection.items.slice(0, 6),
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
  const soulSummary = firstMarkdownParagraph(soulBody);
  const profileSummary = summary;
  const sections: FactoryProfileSectionView[] = [
    ...(roles.length > 0 ? [{ title: "Roles", items: roles.slice(0, 6) }] : []),
    ...(responsibilities.length > 0 ? [{ title: "Responsibilities", items: responsibilities.slice(0, 6) }] : []),
    ...markdownSections.filter((section) => {
      const normalizedTitle = section.title.trim().toLowerCase();
      if (roles.length > 0 && normalizedTitle === "roles") return false;
      if (responsibilities.length > 0 && normalizedTitle === "responsibilities") return false;
      return true;
    }),
  ];
  return {
    summary: soulSummary ?? roles[0] ?? profileSummary,
    soulSummary,
    profileSummary,
    sections: sections.slice(0, 6),
    primaryRole: roles[0],
    roles,
    responsibilities,
  };
};
