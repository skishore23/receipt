export const jsonStringify = (value: unknown): string =>
  JSON.stringify(value ?? null);

export const jsonStringifyOptional = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

export const jsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const jsonParseOptional = <T>(value: string | null | undefined): T | undefined => {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

