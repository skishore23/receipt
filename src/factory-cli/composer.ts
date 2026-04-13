export type ComposerCommand =
  | {
      readonly type: "help";
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
      readonly type: "note";
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
    }
  | {
      readonly type: "steer";
      readonly message?: string;
    }
  | {
      readonly type: "follow-up";
      readonly message?: string;
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
  { name: "obj", label: "/obj", usage: "/obj <prompt>", description: "Create a new objective from the prompt." },
  { name: "new", label: "/new", usage: "/new <prompt>", description: "Start a new thread from the prompt." },
  { name: "react", label: "/react", usage: "/react [message]", description: "React to the selected objective." },
  { name: "note", label: "/note", usage: "/note [message]", description: "Add a note to the selected objective without mutating it." },
  { name: "watch", label: "/watch", usage: "/watch <objective-id>", description: "Focus an objective by id." },
  { name: "promote", label: "/promote", usage: "/promote", description: "Promote the selected objective." },
  { name: "cancel", label: "/cancel", usage: "/cancel [reason]", description: "Cancel the selected objective." },
  { name: "cleanup", label: "/cleanup", usage: "/cleanup", description: "Clean up the selected objective." },
  { name: "archive", label: "/archive", usage: "/archive", description: "Archive the selected objective." },
  { name: "abort-job", label: "/abort-job", usage: "/abort-job [reason]", description: "Abort the active job.", aliases: ["abortjob"] },
  { name: "steer", label: "/steer", usage: "/steer <message>", description: "Steer the active job for the selected objective." },
  { name: "follow-up", label: "/follow-up", usage: "/follow-up <message>", description: "Send follow-up guidance to the active job for the selected objective.", aliases: ["followup", "follow_up"] },
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
const EXPLICIT_DELIVERY_RE = /\b(build|fix|implement|add|update|change|refactor|remove|rename|replace|support|ship|create|wire up)\b/i;
const INVENTORY_PROMPT_RE = /\b(list|show|inventory|enumerate|count|how many|what are|which|describe)\b/i;
const AWS_RESOURCE_RE = /\b(aws|ec2|instance|instances|container|containers|cluster|clusters|service|services|fargate|s3|bucket|buckets|rds|lambda|vpc|vpcs|subnet|subnets|security group|security groups|nat gateway|nat gateways|load balancer|load balancers|elb|ebs|volume|volumes|snapshot|snapshots|cloudwatch|iam|ecr|ecs|eks)\b/i;
const QA_REVIEW_RE = /\b(review|verify|verification|validate|validation|regression risk|acceptance|acceptance criteria|ship[- ]?ready|ready to ship|readiness|sign off|sign-off|qa)\b/i;
const INFRASTRUCTURE_WORK_RE = /\b(cost|billing|bill|spend|usage|permission|permissions|access|role|roles|policy|policies|latency|throughput|quota|limit|limits|throttle|throttling|config|configuration|scaling|alarm|alarms|secret|secrets)\b/i;
const SOFTWARE_SURFACE_RE = /\b(app|repo|repository|code|dashboard|widget|ui|frontend|backend|endpoint|api|component|screen|page|button|form|migration|schema|query|handler|route|controller|typescript|javascript|react|css|html|sql)\b/i;

const compactPrompt = (prompt: string): string =>
  normalizeBody(prompt).replace(/\s+/g, " ").trim();

export const inferObjectiveProfileHint = (prompt: string): "software" | "infrastructure" | "qa" | undefined => {
  const compact = compactPrompt(prompt).toLowerCase();
  if (!compact) return undefined;
  const referencesAwsResources = AWS_RESOURCE_RE.test(compact);
  const looksLikeQaReview = QA_REVIEW_RE.test(compact) && !referencesAwsResources;
  if (looksLikeQaReview) return "qa";
  const looksLikeInfraWork = referencesAwsResources && (
    INVENTORY_PROMPT_RE.test(compact)
    || INFRASTRUCTURE_WORK_RE.test(compact)
    || DIAGNOSTIC_INVESTIGATION_RE.test(compact)
    || FAILURE_TERMS_RE.test(compact)
    || /^(what|which|why|how)\b/.test(compact)
  ) && !SOFTWARE_SURFACE_RE.test(compact);
  if (looksLikeInfraWork) return "infrastructure";
  if (EXPLICIT_DELIVERY_RE.test(compact)) return "software";
  if ((DIAGNOSTIC_INVESTIGATION_RE.test(compact) || FAILURE_TERMS_RE.test(compact)) && !referencesAwsResources) {
    return "software";
  }
  return undefined;
};

export const inferExplicitDeliveryObjectiveMode = (prompt: string): "delivery" | undefined => {
  const compact = compactPrompt(prompt).toLowerCase();
  if (!compact) return undefined;
  if (DIAGNOSTIC_INVESTIGATION_RE.test(compact)) return undefined;
  if (/^(why|what|how)\b/.test(compact) && FAILURE_TERMS_RE.test(compact)) return undefined;
  if (EXPLICIT_DELIVERY_RE.test(compact)) return "delivery";
  return undefined;
};

const inferObjectiveMode = (prompt: string): "investigation" | undefined => {
  const compact = compactPrompt(prompt).toLowerCase();
  if (!compact) return undefined;
  if (DIAGNOSTIC_INVESTIGATION_RE.test(compact)) return "investigation";
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
        return { ok: false, error: "Select an objective before analyzing it." };
      }
      return {
        ok: true,
        command: {
          type: "react",
          message: payload ? `Analyze: ${payload}` : "Please analyze the current objective state, review the plan, and provide recommendations.",
        },
      };
    case "new":
    case "obj":
      if (!payload) {
        return { ok: false, error: `Use /${name.toLowerCase()} followed by an objective prompt.` };
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
    case "note":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before noting it." };
      }
      return {
        ok: true,
        command: {
          type: "note",
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
    case "steer":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before steering its active job." };
      }
      if (!payload) {
        return { ok: false, error: "Add the updated direction after /steer." };
      }
      return {
        ok: true,
        command: {
          type: "steer",
          message: payload,
        },
      };
    case "follow-up":
    case "followup":
    case "follow_up":
      if (!selectedObjectiveId) {
        return { ok: false, error: "Select an objective before sending follow-up guidance." };
      }
      if (!payload) {
        return { ok: false, error: "Add the extra context after /follow-up." };
      }
      return {
        ok: true,
        command: {
          type: "follow-up",
          message: payload,
        },
      };
    default:
      return {
        ok: false,
        error: `Unknown command '/${name}'. Try /help.`,
      };
  }
};
