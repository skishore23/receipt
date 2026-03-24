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
  { name: "new", label: "/new", usage: "/new <prompt>", description: "Start a new thread from the prompt." },
  { name: "react", label: "/react", usage: "/react [message]", description: "React to the selected objective." },
  { name: "watch", label: "/watch", usage: "/watch <objective-id>", description: "Focus an objective by id." },
  { name: "promote", label: "/promote", usage: "/promote", description: "Promote the selected objective." },
  { name: "cancel", label: "/cancel", usage: "/cancel [reason]", description: "Cancel the selected objective." },
  { name: "cleanup", label: "/cleanup", usage: "/cleanup", description: "Clean up the selected objective." },
  { name: "archive", label: "/archive", usage: "/archive", description: "Archive the selected objective." },
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
