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

  const trimmed = body.slice(1).trim();
  const [name = "", ...rest] = trimmed.split(/\s+/);
  const payload = normalizeBody(trimmed.slice(name.length));
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
