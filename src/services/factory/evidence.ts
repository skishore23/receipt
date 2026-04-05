type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

export type FactoryEvidenceRecord = {
  readonly schemaVersion: number;
  readonly payload: JsonObject;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue =>
  value === null
  || typeof value === "string"
  || typeof value === "number"
  || typeof value === "boolean"
  || (Array.isArray(value) && value.every(isJsonValue))
  || (isRecord(value) && Object.values(value).every(isJsonValue));

export const FACTORY_EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "number" },
    payload: { type: "object" },
  },
  required: ["schemaVersion", "payload"],
  additionalProperties: false,
} as const;

export const isFactoryEvidenceRecord = (value: unknown): value is FactoryEvidenceRecord => {
  if (!isRecord(value)) return false;
  return typeof value.schemaVersion === "number" && Number.isFinite(value.schemaVersion)
    && isRecord(value.payload)
    && Object.values(value.payload).every(isJsonValue);
};

export const normalizeFactoryEvidenceRecord = (value: unknown): FactoryEvidenceRecord | undefined => {
  if (!isFactoryEvidenceRecord(value)) return undefined;
  return {
    schemaVersion: value.schemaVersion,
    payload: value.payload as JsonObject,
  };
};
