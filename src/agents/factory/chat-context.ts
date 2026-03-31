import type { AgentEvent } from "../../modules/agent";

export type FactoryChatResponseStyle = "conversational" | "work";

export type FactoryChatContextSourceRef = {
  readonly stream: string;
  readonly eventType: string;
  readonly ts: number;
  readonly receiptHash: string;
  readonly receiptId?: string;
  readonly globalSeq?: number;
};

export type FactoryChatContextMessage = {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly runId: string;
  readonly ts: number;
  readonly refs: ReadonlyArray<FactoryChatContextSourceRef>;
};

export type FactoryChatContextObjectiveImport = {
  readonly objectiveId: string;
  readonly title?: string;
  readonly status?: string;
  readonly phase?: string;
  readonly summary: string;
  readonly importedBecause: "bound" | "requested" | "live_work";
};

export type FactoryChatContextRuntimeImport = {
  readonly summary: string;
  readonly importedBecause: "bound" | "requested" | "live_work";
  readonly objectiveId?: string;
  readonly focusKind?: "task" | "job";
  readonly focusId?: string;
  readonly active?: boolean;
};

export type FactoryChatContextImports = {
  readonly profileMemorySummary?: string;
  readonly objective?: FactoryChatContextObjectiveImport;
  readonly runtime?: FactoryChatContextRuntimeImport;
};

export type FactoryChatContextProjection = {
  readonly version: 1;
  readonly chatId: string;
  readonly profileId: string;
  readonly updatedAt: number;
  readonly conversation: ReadonlyArray<FactoryChatContextMessage>;
  readonly bindings: {
    readonly chatId: string;
    readonly profileId: string;
    readonly objectiveId?: string;
    readonly latestRunId?: string;
  };
  readonly imports: FactoryChatContextImports;
  readonly style: {
    readonly responseStyle: FactoryChatResponseStyle;
    readonly latestUserText?: string;
  };
  readonly source: {
    readonly sessionStream: string;
    readonly runStreams: ReadonlyArray<string>;
    readonly lastGlobalSeq: number;
    readonly receiptRefs: ReadonlyArray<FactoryChatContextSourceRef>;
  };
};

export type FactoryChatContextReceiptLike = {
  readonly stream: string;
  readonly ts: number;
  readonly hash: string;
  readonly body: AgentEvent;
  readonly id?: string;
  readonly eventType?: string;
  readonly globalSeq?: number;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const normalizeForGrouping = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const classifyFactoryResponseStyle = (problem: string): FactoryChatResponseStyle => {
  const compact = problem.replace(/\s+/g, " ").trim();
  if (!compact) return "work";
  if (compact.length <= 140) return "conversational";
  return "work";
};

export const renderFactoryResponseStyleGuidance = (
  styleOrProblem: FactoryChatResponseStyle | string,
): string => {
  const style = styleOrProblem === "conversational" || styleOrProblem === "work"
    ? styleOrProblem
    : classifyFactoryResponseStyle(styleOrProblem);
  if (style === "conversational") {
    return [
      "- This turn is conversational or meta. Answer like a human engineer talking to another person.",
      "- Prefer short natural prose. Use first person for self-reflection.",
      "- Do not use headings, scorecards, grades, verdict labels, or rubric language unless the user explicitly asked for that format.",
      "- Do not turn the reply into operator-handoff analysis, workflow briefing, or report scaffolding.",
    ].join("\n");
  }
  return [
    "- This turn is work-focused. Use structure only when it genuinely helps the operator.",
    "- Keep the answer direct and specific; do not default to a report template if a short paragraph would do.",
    "- Mention workflow mechanics only when they materially affect the next step or the freshness of the answer.",
  ].join("\n");
};

export const isFactoryChatSessionStream = (stream: string | undefined): boolean => {
  const value = stream?.trim();
  return Boolean(value && /\/sessions\/[^/]+$/.test(value));
};

export const chatSessionStreamFromStream = (stream: string | undefined): string | undefined => {
  const value = stream?.trim();
  if (!value) return undefined;
  const runMarker = "/runs/";
  const runIndex = value.indexOf(runMarker);
  const candidate = runIndex >= 0 ? value.slice(0, runIndex) : value;
  return isFactoryChatSessionStream(candidate) ? candidate : undefined;
};

export const parseFactoryChatSessionStream = (stream: string): {
  readonly profileId: string;
  readonly chatId: string;
} | undefined => {
  const normalized = chatSessionStreamFromStream(stream);
  if (!normalized) return undefined;
  const match = normalized.match(/^agents\/factory\/[^/]+\/([^/]+)\/sessions\/(.+)$/);
  if (!match) return undefined;
  const [, encodedProfileId, encodedChatId] = match;
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return {
    profileId: decode(encodedProfileId),
    chatId: decode(encodedChatId),
  };
};

const toSourceRef = (receipt: FactoryChatContextReceiptLike): FactoryChatContextSourceRef => ({
  stream: receipt.stream,
  eventType: receipt.eventType ?? receipt.body.type,
  ts: receipt.ts,
  receiptHash: receipt.hash,
  receiptId: receipt.id,
  globalSeq: receipt.globalSeq,
});

const mergeSourceRefs = (
  existing: ReadonlyArray<FactoryChatContextSourceRef>,
  next: FactoryChatContextSourceRef,
): ReadonlyArray<FactoryChatContextSourceRef> => {
  if (existing.some((ref) => ref.receiptHash === next.receiptHash && ref.stream === next.stream)) return existing;
  return [...existing, next];
};

export const projectFactoryChatContextFromReceipts = (input: {
  readonly sessionStream: string;
  readonly receipts: ReadonlyArray<FactoryChatContextReceiptLike>;
  readonly updatedAt?: number;
}): FactoryChatContextProjection | undefined => {
  const parsed = parseFactoryChatSessionStream(input.sessionStream);
  if (!parsed) return undefined;

  const ordered = [...input.receipts]
    .filter((receipt) => chatSessionStreamFromStream(receipt.stream) === input.sessionStream)
    .sort((left, right) =>
      (left.globalSeq ?? Number.MAX_SAFE_INTEGER) - (right.globalSeq ?? Number.MAX_SAFE_INTEGER)
      || left.ts - right.ts
      || left.hash.localeCompare(right.hash));
  const sessionReceipts = ordered.filter((receipt) => receipt.stream === input.sessionStream);
  const candidateConversationReceipts = sessionReceipts.some((receipt) =>
    receipt.body.type === "problem.set" || receipt.body.type === "response.finalized")
    ? sessionReceipts
    : ordered;

  const messages = new Map<string, {
    role: "user" | "assistant";
    text: string;
    runId: string;
    ts: number;
    refs: ReadonlyArray<FactoryChatContextSourceRef>;
    orderKey: number;
  }>();

  for (const receipt of candidateConversationReceipts) {
    const body = receipt.body;
    const role = body.type === "problem.set"
      ? "user"
      : body.type === "response.finalized"
        ? "assistant"
        : undefined;
    const text = body.type === "problem.set"
      ? asString(body.problem)
      : body.type === "response.finalized"
        ? asString(body.content)
        : undefined;
    if (!role || !text) continue;
    const key = `${role}:${body.runId}:${normalizeForGrouping(text)}`;
    const ref = toSourceRef(receipt);
    const existing = messages.get(key);
    if (!existing) {
      messages.set(key, {
        role,
        text,
        runId: body.runId,
        ts: receipt.ts,
        refs: [ref],
        orderKey: receipt.globalSeq ?? receipt.ts,
      });
      continue;
    }
    messages.set(key, {
      ...existing,
      refs: mergeSourceRefs(existing.refs, ref),
      ts: Math.min(existing.ts, receipt.ts),
      orderKey: Math.min(existing.orderKey, receipt.globalSeq ?? receipt.ts),
    });
  }

  const conversation = [...messages.values()]
    .sort((left, right) => left.orderKey - right.orderKey || left.ts - right.ts || left.runId.localeCompare(right.runId))
    .map((message) => ({
      role: message.role,
      text: message.text,
      runId: message.runId,
      ts: message.ts,
      refs: [...message.refs].sort((left, right) =>
        (left.globalSeq ?? Number.MAX_SAFE_INTEGER) - (right.globalSeq ?? Number.MAX_SAFE_INTEGER)
        || left.ts - right.ts
        || left.receiptHash.localeCompare(right.receiptHash)),
    }) satisfies FactoryChatContextMessage);

  const latestBindingReceipt = [...ordered].reverse().find((receipt) => receipt.body.type === "thread.bound");
  const latestRunId = [...conversation].reverse().find((message) => Boolean(message.runId))?.runId
    ?? (latestBindingReceipt?.body.type === "thread.bound" ? latestBindingReceipt.body.runId : undefined);
  const latestUserText = [...conversation].reverse().find((message) => message.role === "user")?.text;
  const receiptRefs = [
    ...conversation.flatMap((message) => message.refs),
    ...(latestBindingReceipt ? [toSourceRef(latestBindingReceipt)] : []),
  ].reduce<FactoryChatContextSourceRef[]>((acc, ref) => (
    acc.some((candidate) => candidate.receiptHash === ref.receiptHash && candidate.stream === ref.stream)
      ? acc
      : [...acc, ref]
  ), []);
  const runStreams = [...new Set(
    ordered
      .map((receipt) => receipt.stream)
      .filter((stream) => stream !== input.sessionStream && stream.startsWith(`${input.sessionStream}/runs/`)),
  )];
  const lastGlobalSeq = ordered.reduce((max, receipt) => Math.max(max, receipt.globalSeq ?? 0), 0);
  const updatedAt = input.updatedAt
    ?? ordered.reduce((max, receipt) => Math.max(max, receipt.ts), 0)
    ?? Date.now();

  return {
    version: 1,
    chatId: parsed.chatId,
    profileId: parsed.profileId,
    updatedAt,
    conversation,
    bindings: {
      chatId: parsed.chatId,
      profileId: parsed.profileId,
      objectiveId: latestBindingReceipt?.body.type === "thread.bound"
        ? latestBindingReceipt.body.objectiveId
        : undefined,
      latestRunId,
    },
    imports: {},
    style: {
      responseStyle: classifyFactoryResponseStyle(latestUserText ?? ""),
      latestUserText,
    },
    source: {
      sessionStream: input.sessionStream,
      runStreams,
      lastGlobalSeq,
      receiptRefs,
    },
  };
};

export const withFactoryChatContextImports = (
  base: FactoryChatContextProjection,
  imports: FactoryChatContextImports,
): FactoryChatContextProjection => ({
  ...base,
  imports: {
    ...base.imports,
    ...imports,
  },
});

export const groupFactoryChatConversationByRunId = (
  conversation: ReadonlyArray<FactoryChatContextMessage> | undefined,
): ReadonlyMap<string, ReadonlyArray<FactoryChatContextMessage>> => {
  const grouped = new Map<string, FactoryChatContextMessage[]>();
  for (const message of conversation ?? []) {
    const bucket = grouped.get(message.runId) ?? [];
    bucket.push(message);
    grouped.set(message.runId, bucket);
  }
  return grouped;
};

export const renderFactoryChatConversationTranscript = (
  conversation: ReadonlyArray<FactoryChatContextMessage>,
  limit = 12,
): string => {
  const messages = conversation.slice(-Math.max(1, limit));
  if (messages.length === 0) return "(no prior steps)";
  return messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`).join("\n\n");
};

export const renderFactoryChatContextImports = (
  imports: FactoryChatContextImports,
): string => {
  const sections = [
    imports.profileMemorySummary
      ? `Profile memory:\n${imports.profileMemorySummary}`
      : undefined,
    imports.objective
      ? [
          `Objective (${imports.objective.importedBecause}):`,
          imports.objective.title
            ? `${imports.objective.title} (${imports.objective.objectiveId})`
            : imports.objective.objectiveId,
          [imports.objective.status, imports.objective.phase].filter(Boolean).join(" · "),
          imports.objective.summary,
        ].filter(Boolean).join("\n")
      : undefined,
    imports.runtime
      ? [
          `Runtime (${imports.runtime.importedBecause}):`,
          imports.runtime.summary,
          [
            imports.runtime.objectiveId ? `objective ${imports.runtime.objectiveId}` : undefined,
            imports.runtime.focusKind && imports.runtime.focusId
              ? `${imports.runtime.focusKind} ${imports.runtime.focusId}`
              : undefined,
            imports.runtime.active === true
              ? "active"
              : imports.runtime.active === false
                ? "inactive"
                : undefined,
          ].filter(Boolean).join(" · "),
        ].filter(Boolean).join("\n")
      : undefined,
  ].filter((section): section is string => Boolean(section?.trim()));
  return sections.join("\n\n") || "(none)";
};
