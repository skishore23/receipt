export type ComposerCommand =
  | {
      readonly type: "help";
    }
  | {
      readonly type: "analyze";
    }
  | {
      readonly type: "new";
      readonly prompt: string;
      readonly title?: string;
      readonly objectiveMode?: "delivery" | "investigation";
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
  { name: "analyze", label: "/analyze", usage: "/analyze", description: "Open the run analysis for the selected objective." },
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

const DIAGNOSTIC_INVESTIGATION_RE = /\b(investigate|investigation|debug|diagnose|diagnostic|root cause|triage|look into|find out|figure out|trace|explain why|what is causing|what's causing)\b/i;
const FAILURE_TERMS_RE = /\b(fail|failing|failed|failure|broken|error|issue|problem|crash|hang|timeout|timed out|not working|regression|flake|flaky|build|test|tests|compile|compilation|lint|ci|deploy)\b/i;
const EXPLICIT_DELIVERY_RE = /\b(fix|implement|add|update|change|refactor|remove|rename|support|ship|create|wire up)\b/i;
const INVENTORY_PROMPT_RE = /\b(list|show|inventory|enumerate|count|how many|what are|which|describe)\b/i;
const AWS_RESOURCE_RE = /\b(aws|ec2|instance|instances|container|containers|cluster|clusters|service|services|fargate|s3|bucket|buckets|rds|lambda|vpc|vpcs|subnet|subnets|security group|security groups|nat gateway|nat gateways|load balancer|load balancers|elb|ebs|volume|volumes|snapshot|snapshots|cloudwatch|iam|ecr|ecs|eks)\b/i;

const compactPrompt = (prompt: string): string =>
  normalizeBody(prompt).replace(/\s+/g, " ").trim();

export const inferObjectiveProfileHint = (prompt: string): "infrastructure" | undefined => {
  const compact = compactPrompt(prompt).toLowerCase();
  if (!compact) return undefined;
  if (EXPLICIT_DELIVERY_RE.test(compact)) return undefined;
  if (INVENTORY_PROMPT_RE.test(compact) && AWS_RESOURCE_RE.test(compact)) return "infrastructure";
  if (/^(what|which)\b/.test(compact) && AWS_RESOURCE_RE.test(compact)) return "infrastructure";
  return undefined;
};

const inferObjectiveMode = (prompt: string): "investigation" | undefined => {
  const compact = compactPrompt(prompt).toLowerCase();
  if (!compact) return undefined;
  if (DIAGNOSTIC_INVESTIGATION_RE.test(compact)) return "investigation";
  if (EXPLICIT_DELIVERY_RE.test(compact)) return undefined;
  if (/^(why|what|how)\b/.test(compact) && FAILURE_TERMS_RE.test(compact)) return "investigation";
  return undefined;
};

const rewriteInvestigationPrompt = (prompt: string): string => {
  const normalized = normalizeBody(prompt);
  if (!normalized) return normalized;
  if (/determine the concrete root cause from evidence before proposing or applying fixes\./i.test(normalized)) {
    return normalized;
  }
  return [
    normalized,
    "",
    "Treat this as an investigation request. Determine the concrete root cause from evidence before proposing or applying fixes.",
  ].join("\n");
};

export const deriveObjectiveTitle = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "Factory objective";
  const firstSentence = compact.split(/[.!?]/)[0] ?? compact;
  return firstSentence.slice(0, 96).trim() || "Factory objective";
};

export const prepareObjectiveCreation = (
  prompt: string,
  options?: {
    readonly title?: string;
    readonly objectiveMode?: "delivery" | "investigation";
  },
): {
  readonly prompt: string;
  readonly title: string;
  readonly objectiveMode?: "delivery" | "investigation";
} => {
  const normalizedPrompt = normalizeBody(prompt);
  const objectiveMode = options?.objectiveMode ?? inferObjectiveMode(normalizedPrompt);
  const rewrittenPrompt = objectiveMode === "investigation"
    ? rewriteInvestigationPrompt(normalizedPrompt)
    : normalizedPrompt;
  const compact = compactPrompt(normalizedPrompt);
  const title = options?.title?.trim()
    || (objectiveMode === "investigation"
      ? deriveObjectiveTitle(/^(investigate|debug|diagnose|triage|trace)\b/i.test(compact) ? compact : `Investigate: ${compact}`)
      : deriveObjectiveTitle(normalizedPrompt));
  return {
    prompt: rewrittenPrompt,
    title,
    ...(objectiveMode ? { objectiveMode } : {}),
  };
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
    const prepared = prepareObjectiveCreation(body);
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
        prompt: prepared.prompt,
        title: prepared.title,
        objectiveMode: prepared.objectiveMode,
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
    case "analyze":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before opening its analysis." };
      }
      return { ok: true, command: { type: "analyze" } };
    case "new":
      if (!payload) {
        return { ok: false, error: "Use /new followed by an objective prompt." };
      }
      {
        const prepared = prepareObjectiveCreation(payload);
        return {
          ok: true,
          command: {
            type: "new",
            prompt: prepared.prompt,
            title: prepared.title,
            objectiveMode: prepared.objectiveMode,
          },
        };
      }
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
