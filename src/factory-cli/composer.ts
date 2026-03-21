export type ComposerCommand =
  | {
      readonly type: "help";
    }
  | {
      readonly type: "new";
      readonly prompt: string;
      readonly title?: string;
    }
  | {
      readonly type: "react";
      readonly message?: string;
    }
  | {
      readonly type: "watch";
      readonly objectiveId?: string;
    }
  | {
      readonly type: "promote";
    }
  | {
      readonly type: "cancel";
      readonly reason?: string;
    }
  | {
      readonly type: "cleanup";
    }
  | {
      readonly type: "archive";
    }
  | {
      readonly type: "steer";
      readonly problem?: string;
    }
  | {
      readonly type: "follow-up";
      readonly note?: string;
    }
  | {
      readonly type: "abort-job";
      readonly reason?: string;
    };

export type ParsedComposerDraft =
  | {
      readonly ok: true;
      readonly command: ComposerCommand;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export type ComposerCommandDefinition = {
  readonly name: string;
  readonly label: string;
  readonly usage: string;
  readonly description: string;
  readonly aliases?: ReadonlyArray<string>;
};

export const COMPOSER_COMMANDS: ReadonlyArray<ComposerCommandDefinition> = [
  { name: "help", label: "/help", usage: "/help or /?", description: "Show slash command help.", aliases: ["?", "help"] },
  { name: "new", label: "/new", usage: "/new <prompt>", description: "Create a new objective from the prompt." },
  { name: "react", label: "/react", usage: "/react [message]", description: "React to the selected objective." },
  { name: "watch", label: "/watch", usage: "/watch <objective-id>", description: "Focus an objective by id." },
  { name: "promote", label: "/promote", usage: "/promote", description: "Promote the selected objective." },
  { name: "cancel", label: "/cancel", usage: "/cancel [reason]", description: "Cancel the selected objective." },
  { name: "cleanup", label: "/cleanup", usage: "/cleanup", description: "Clean up the selected objective." },
  { name: "archive", label: "/archive", usage: "/archive", description: "Archive the selected objective." },
  { name: "steer", label: "/steer", usage: "/steer [problem]", description: "Send guidance to the active job." },
  { name: "follow-up", label: "/follow-up", usage: "/follow-up [note]", description: "Send a follow-up note to the active job.", aliases: ["followup"] },
  { name: "abort-job", label: "/abort-job", usage: "/abort-job [reason]", description: "Abort the active job.", aliases: ["abortjob"] },
] as const;

const COMMAND_LOOKUP = new Map(
  COMPOSER_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])].map((alias) => [alias, command] as const)),
);

const parseComposerCommandToken = (draft: string): { readonly name: string; readonly payload: string } | undefined => {
  const body = normalizeBody(draft);
  if (!body) return undefined;
  const match = body.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return {
    name: match[1] ?? "",
    payload: normalizeBody(match[2] ?? ""),
  };
};

export type ComposerSlashContext = {
  readonly before: string;
  readonly after: string;
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly query: string;
  readonly commandPrefix: string;
};

export const findComposerSlashContext = (value: string, caret: number): ComposerSlashContext | undefined => {
  const safeCaret = Math.max(0, Math.min(caret, value.length));
  const start = value.lastIndexOf("/", safeCaret - 1);
  if (start < 0) return undefined;
  const beforeSlash = value.slice(0, start);
  const tokenStart = start;
  const tokenEnd = safeCaret;
  const token = value.slice(tokenStart, tokenEnd);
  if (/\s/.test(beforeSlash.slice(-1)) || beforeSlash.length === 0 || /\s/.test(token.slice(0, 1)) || /\s/.test(value.slice(start + 1, safeCaret))) {
    const head = beforeSlash.match(/(^|\s)$/);
    if (!head && beforeSlash.length > 0) return undefined;
  }
  const prefixEnd = value.indexOf(" ", tokenStart + 1);
  const commandEnd = prefixEnd === -1 ? value.length : prefixEnd;
  if (safeCaret < tokenStart + 1 || safeCaret > commandEnd) return undefined;
  const before = value.slice(0, tokenStart);
  const after = value.slice(commandEnd);
  const query = value.slice(tokenStart + 1, safeCaret);
  return {
    before,
    after,
    tokenStart,
    tokenEnd: commandEnd,
    query,
    commandPrefix: value.slice(tokenStart + 1, Math.min(commandEnd, safeCaret)),
  };
};

export const replaceComposerSlashContext = (value: string, context: ComposerSlashContext, insert: string): { readonly value: string; readonly caret: number } => {
  const nextValue = `${context.before}${insert}${context.after}`;
  return { value: nextValue, caret: context.before.length + insert.length };
};

export const filterComposerCommands = (query: string): ReadonlyArray<ComposerCommandDefinition> => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return COMPOSER_COMMANDS;
  return COMPOSER_COMMANDS.filter((command) => {
    const haystack = [command.name, command.label, command.usage, command.description, ...(command.aliases ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
};

export const resolveComposerCommand = (name: string): ComposerCommandDefinition | undefined => COMMAND_LOOKUP.get(name.toLowerCase());

const normalizeBody = (value: string): string =>
  value
    .replace(/\r\n/g, "\n")
    .trim();

export const deriveObjectiveTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "Factory objective";
  const firstSentence = compact.split(/[.!?]/)[0] ?? compact;
  return firstSentence.slice(0, 96).trim() || "Factory objective";
};

export const parseComposerDraft = (draft: string, selectedObjectiveId?: string): ParsedComposerDraft => {
  const body = normalizeBody(draft);
  if (!body) {
    return {
      ok: false,
      error: "Type a slash command or describe the objective.",
    };
  }

  if (!body.startsWith("/")) {
    if (selectedObjectiveId) {
      return {
        ok: true,
        command: {
          type: "react",
          message: body,
        },
      };
    }
    return {
      ok: true,
      command: {
        type: "new",
        prompt: body,
        title: deriveObjectiveTitle(body),
      },
    };
  }

  const parsedCommand = parseComposerCommandToken(body);
  if (!parsedCommand) {
    return {
      ok: false,
      error: "Type a slash command or describe the objective.",
    };
  }
  const { name, payload } = parsedCommand;
  const command = resolveComposerCommand(name);
  if (!command) {
    return {
      ok: false,
      error: `Unknown command '/${name}'. Try /help.`,
    };
  }
  switch (name.toLowerCase()) {
    case "?":
    case "help":
      return { ok: true, command: { type: "help" } };
    case "new":
      if (!payload) {
        return { ok: false, error: "Use /new followed by an objective prompt." };
      }
      return {
        ok: true,
        command: {
          type: "new",
          prompt: payload,
          title: deriveObjectiveTitle(payload),
        },
      };
    case "react":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before reacting to it." };
      }
      return {
        ok: true,
        command: {
          type: "react",
          message: payload || undefined,
        },
      };
    case "watch":
      return {
        ok: true,
        command: {
          type: "watch",
          objectiveId: payload || undefined,
        },
      };
    case "promote":
      return { ok: true, command: { type: "promote" } };
    case "cancel":
      return {
        ok: true,
        command: {
          type: "cancel",
          reason: payload || undefined,
        },
      };
    case "cleanup":
      return { ok: true, command: { type: "cleanup" } };
    case "archive":
      return { ok: true, command: { type: "archive" } };
    case "steer":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before steering its active job." };
      }
      return {
        ok: true,
        command: {
          type: "steer",
          problem: payload || undefined,
        },
      };
    case "follow-up":
    case "followup":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before sending a follow-up note." };
      }
      return {
        ok: true,
        command: {
          type: "follow-up",
          note: payload || undefined,
        },
      };
    case "abort-job":
    case "abortjob":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before aborting its active job." };
      }
      return {
        ok: true,
        command: {
          type: "abort-job",
          reason: payload || undefined,
        },
      };
    default:
      return {
        ok: false,
        error: `Unknown command '/${name}'. Try /help.`,
      };
  }
};
