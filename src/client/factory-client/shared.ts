import type {
  FactoryChatIslandState,
  FactoryComposeResponseBody,
  FactoryLiveScopePayload,
} from "../../agents/factory/client-contract";

export type { FactoryChatIslandState, FactoryComposeResponseBody, FactoryLiveScopePayload };

export type FactoryCommand = {
  readonly name: string;
  readonly label: string;
  readonly usage: string;
  readonly description: string;
  readonly aliases?: ReadonlyArray<string>;
};

export type StreamingReply = {
  readonly runId?: string;
  readonly profileLabel?: string;
  readonly text: string;
};

export type TokenEventPayload = {
  readonly runId?: string;
  readonly delta: string;
};

export type FactoryFetchResponse = {
  readonly ok: boolean;
  readonly headers: {
    readonly get: (name: string) => string | null;
  };
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
};

export const DEFAULT_COMMANDS: ReadonlyArray<FactoryCommand> = [];
export const ASSISTANT_RESPONSE_CARD_CLASS = "overflow-hidden border border-border/80 bg-card";
export const ASSISTANT_RESPONSE_BODY_CLASS = "max-w-[72ch] px-5 py-4 sm:px-6 sm:py-5";

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

export const parseCommands = (node: Element | null): ReadonlyArray<FactoryCommand> => {
  if (!node) return DEFAULT_COMMANDS;
  const raw = node.getAttribute("data-composer-commands");
  if (!raw) return DEFAULT_COMMANDS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COMMANDS;
    return parsed.flatMap((item) => {
      const command = asRecord(item);
      const name = asString(command?.name);
      const label = asString(command?.label);
      const usage = asString(command?.usage);
      const description = asString(command?.description);
      if (!name || !label || !usage || !description) return [];
      const aliases = command && Array.isArray(command.aliases)
        ? command.aliases.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
      return [{
        name,
        label,
        usage,
        description,
        aliases,
      }];
    });
  } catch (_err) {
    return DEFAULT_COMMANDS;
  }
};

export const escapeHtml = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const dispatchBodyEvent = (eventName: string, detail?: unknown): void => {
  if (!document.body || typeof window.CustomEvent !== "function") return;
  document.body.dispatchEvent(new window.CustomEvent(eventName, {
    bubbles: true,
    detail,
  }));
};

export const queueBodyEvent = (eventName: string, delayMs = 0, detail?: unknown): number =>
  window.setTimeout(() => {
    dispatchBodyEvent(eventName, detail);
  }, Math.max(0, delayMs));
