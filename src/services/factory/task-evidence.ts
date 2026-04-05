import type { FactoryStructuredEvidenceRecord } from "../../modules/factory/types";

const trimText = (value: string, max: number): string =>
  value.trim().length > max ? `${value.trim().slice(0, max - 1)}...` : value.trim();

export type FactoryTaskEvidenceCollector = {
  readonly addTable: (title: string, summary: string, detail?: string | null) => void;
  readonly addCommand: (command: string, summary: string, detail?: string | null) => void;
  readonly addNote: (title: string, summary: string, detail?: string | null) => void;
  readonly structuredEvidence: ReadonlyArray<FactoryStructuredEvidenceRecord>;
};

export const createFactoryTaskEvidenceCollector = (): FactoryTaskEvidenceCollector => {
  const structuredEvidence: FactoryStructuredEvidenceRecord[] = [];
  const add = (title: string, summary: string, detail?: string | null): void => {
    structuredEvidence.push({
      title: trimText(title, 120),
      summary: trimText(summary, 240),
      detail: typeof detail === "string" && detail.trim().length > 0 ? trimText(detail, 600) : null,
    });
  };

  return {
    addTable: (title, summary, detail) => add(title, summary, detail),
    addCommand: (command, summary, detail) => add(`Command: ${command}`, summary, detail),
    addNote: (title, summary, detail) => add(title, summary, detail),
    get structuredEvidence() {
      return structuredEvidence;
    },
  };
};
