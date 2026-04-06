import type { Runtime } from "@receipt/core/runtime";

import {
  forgetMemoryEntry,
  type MemoryCmd,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryState,
  type MemoryTools,
} from "../adapters/memory-tools";
import {
  readSessionHistory,
  searchSessionHistory,
  type SessionHistoryMessage,
  type SessionSearchResult,
} from "./session-history";

export const DEFAULT_USER_ID = "default";

export type PreferenceCategory =
  | "formatting"
  | "tone"
  | "depth"
  | "workflow"
  | "tool_behavior"
  | "assumptions"
  | "other";

export type PreferenceMemoryMeta = {
  readonly kind: "preference";
  readonly category: PreferenceCategory;
  readonly source: "explicit_user" | "model_inference";
  readonly status: "active";
  readonly originRunId?: string;
  readonly originSessionStream?: string;
  readonly originMessageIds?: ReadonlyArray<string>;
};

export type UserPreferenceScopeMode = "global" | "repo" | "layered";

export type ConversationProjection = {
  readonly userPreferences?: string;
  readonly recentSessionMessages: ReadonlyArray<SessionHistoryMessage>;
  readonly sessionRecall: ReadonlyArray<SessionSearchResult>;
};

export const globalUserProfileScope = (): string => `users/${DEFAULT_USER_ID}/profile`;
export const globalUserPreferenceScope = (): string => `users/${DEFAULT_USER_ID}/preferences`;
export const repoUserProfileScope = (repoKey: string): string => `repos/${repoKey}/users/${DEFAULT_USER_ID}/profile`;
export const repoUserPreferenceScope = (repoKey: string): string => `repos/${repoKey}/users/${DEFAULT_USER_ID}/preferences`;

export const normalizePreferenceText = (value: string): string =>
  value
    .replace(/^[-*]\s+/, "")
    .replace(/^user preference:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizePreferenceKey = (value: string): string =>
  normalizePreferenceText(value).toLowerCase();

const inferPreferenceCategory = (text: string): PreferenceCategory => {
  const normalized = text.toLowerCase();
  if (/(bullet|heading|markdown|table|format|section|json|yaml|example|assumption|caveat|line reference|citation|short|concise|brief)/.test(normalized)) {
    return "formatting";
  }
  if (/(tone|voice|formal|casual|direct|polite|human|conversational|blunt)/.test(normalized)) {
    return "tone";
  }
  if (/(deep|depth|summary|detail|high level|step by step|thorough)/.test(normalized)) {
    return "depth";
  }
  if (/(workflow|default to|always|never|prefer|first step|before|after|follow up)/.test(normalized)) {
    return "workflow";
  }
  if (/(tool|cli|terminal|search|browse|test|lint|commit|push|git)/.test(normalized)) {
    return "tool_behavior";
  }
  if (/(assume|assumption|unknown|uncertain|if you are unsure)/.test(normalized)) {
    return "assumptions";
  }
  return "other";
};

const readScopeEntries = async (
  memoryTools: MemoryTools,
  scope: string,
  audit: Readonly<Record<string, unknown>>,
  limit = 12,
): Promise<ReadonlyArray<MemoryEntry>> => {
  try {
    return await memoryTools.read({ scope, limit, audit });
  } catch {
    return [];
  }
};

const dedupeEntries = (
  entries: ReadonlyArray<MemoryEntry>,
  maxEntries: number,
): ReadonlyArray<MemoryEntry> => {
  const seen = new Set<string>();
  const ordered: MemoryEntry[] = [];
  for (const entry of entries) {
    const key = normalizePreferenceKey(entry.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ordered.push(entry);
    if (ordered.length >= maxEntries) break;
  }
  return ordered;
};

const formatEntries = (entries: ReadonlyArray<MemoryEntry>): string | undefined => {
  const lines = dedupeEntries(entries, 10)
    .map((entry) => normalizePreferenceText(entry.text))
    .filter(Boolean);
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : undefined;
};

const preferenceScopesFor = (repoKey?: string, scopeMode: UserPreferenceScopeMode = "layered"): ReadonlyArray<string> => {
  switch (scopeMode) {
    case "global":
      return [globalUserPreferenceScope()];
    case "repo":
      return repoKey ? [repoUserPreferenceScope(repoKey)] : [];
    case "layered":
    default:
      return [
        repoKey ? repoUserPreferenceScope(repoKey) : undefined,
        globalUserPreferenceScope(),
      ].filter((scope): scope is string => Boolean(scope));
  }
};

const profileScopesFor = (repoKey?: string): ReadonlyArray<string> => [
  repoKey ? repoUserProfileScope(repoKey) : undefined,
  globalUserProfileScope(),
].filter((scope): scope is string => Boolean(scope));

export const summarizeUserPreferences = async (input: {
  readonly memoryTools: MemoryTools;
  readonly repoKey?: string;
  readonly runId: string;
  readonly iteration?: number;
  readonly actor: string;
  readonly scopeMode?: UserPreferenceScopeMode;
}): Promise<string | undefined> => {
  const auditBase = {
    actor: input.actor,
    operation: "user-preference-read",
    runId: input.runId,
    iteration: input.iteration,
    label: "User preferences",
  } as const;
  const preferenceEntries = (
    await Promise.all(preferenceScopesFor(input.repoKey, input.scopeMode).map((scope) =>
      readScopeEntries(input.memoryTools, scope, { ...auditBase, scope })
    ))
  ).flat();
  const profileEntries = (
    await Promise.all(profileScopesFor(input.repoKey).map((scope) =>
      readScopeEntries(input.memoryTools, scope, { ...auditBase, scope })
    ))
  ).flat();
  const preferencesBlock = formatEntries(preferenceEntries);
  const profileBlock = formatEntries(profileEntries);
  if (!preferencesBlock && !profileBlock) return undefined;
  if (preferencesBlock && !profileBlock) return preferencesBlock;
  if (!preferencesBlock && profileBlock) return `Profile conventions:\n${profileBlock}`;
  return `Preferences:\n${preferencesBlock}\n\nProfile conventions:\n${profileBlock}`;
};

export const listUserPreferenceEntries = async (input: {
  readonly memoryTools: MemoryTools;
  readonly repoKey?: string;
  readonly runId: string;
  readonly actor: string;
  readonly scopeMode?: UserPreferenceScopeMode;
}): Promise<ReadonlyArray<MemoryEntry>> => {
  const entries = (
    await Promise.all(preferenceScopesFor(input.repoKey, input.scopeMode).map((scope) =>
      readScopeEntries(input.memoryTools, scope, {
        actor: input.actor,
        operation: "user-preference-list",
        runId: input.runId,
        scope,
        label: "User preferences",
      }, 100)
    ))
  ).flat();
  return dedupeEntries(entries, 100);
};

export const commitUserPreference = async (input: {
  readonly memoryTools: MemoryTools;
  readonly text: string;
  readonly repoKey?: string;
  readonly source: PreferenceMemoryMeta["source"];
  readonly runId?: string;
  readonly sessionStream?: string;
  readonly originMessageIds?: ReadonlyArray<string>;
  readonly actor: string;
}): Promise<MemoryEntry | undefined> => {
  const normalized = normalizePreferenceText(input.text);
  if (!normalized) return undefined;
  const scope = input.repoKey ? repoUserPreferenceScope(input.repoKey) : globalUserPreferenceScope();
  const existing = await readScopeEntries(input.memoryTools, scope, {
    actor: input.actor,
    operation: "user-preference-read",
    runId: input.runId,
    label: "User preferences",
  }, 100);
  const existingEntry = existing.find((entry) => normalizePreferenceKey(entry.text) === normalizePreferenceKey(normalized));
  if (existingEntry) return existingEntry;
  return await input.memoryTools.commit({
    scope,
    text: normalized,
    tags: ["user-preference"],
    meta: {
      kind: "preference",
      category: inferPreferenceCategory(normalized),
      source: input.source,
      status: "active",
      originRunId: input.runId,
      originSessionStream: input.sessionStream,
      originMessageIds: input.originMessageIds,
    } satisfies PreferenceMemoryMeta,
    audit: {
      actor: input.actor,
      operation: "user-preference-commit",
      runId: input.runId,
      label: "User preferences",
    },
  });
};

export const rememberUserPreferenceNotes = async (input: {
  readonly memoryTools: MemoryTools;
  readonly preferenceNotes: ReadonlyArray<string>;
  readonly repoKey?: string;
  readonly runId: string;
  readonly actor: string;
  readonly sessionStream?: string;
  readonly originMessageIds?: ReadonlyArray<string>;
}): Promise<void> => {
  const notes = [...new Set(input.preferenceNotes.map(normalizePreferenceText).filter(Boolean))].slice(0, 6);
  for (const note of notes) {
    await commitUserPreference({
      memoryTools: input.memoryTools,
      text: note,
      repoKey: input.repoKey,
      source: "model_inference",
      runId: input.runId,
      sessionStream: input.sessionStream,
      originMessageIds: input.originMessageIds,
      actor: input.actor,
    });
  }
};

export const removeUserPreferenceEntry = async (input: {
  readonly dir: string;
  readonly runtime: Runtime<MemoryCmd, MemoryEvent, MemoryState>;
  readonly entryId: string;
  readonly scope: string;
}): Promise<boolean> =>
  forgetMemoryEntry({
    dir: input.dir,
    runtime: input.runtime,
    entryId: input.entryId,
    scope: input.scope,
  });

export const renderSessionRecallSummary = (
  items: ReadonlyArray<SessionSearchResult>,
): string | undefined => {
  if (items.length === 0) return undefined;
  return items.map((item) => `- ${item.chatId} · ${item.role}: ${item.snippet}`).join("\n");
};

export const loadConversationProjection = async (input: {
  readonly memoryTools: MemoryTools;
  readonly repoKey?: string;
  readonly profileId?: string;
  readonly sessionStream?: string;
  readonly dataDir?: string;
  readonly query?: string;
  readonly runId: string;
  readonly iteration?: number;
  readonly actor: string;
  readonly recentLimit?: number;
  readonly recallLimit?: number;
}): Promise<ConversationProjection> => {
  const userPreferences = await summarizeUserPreferences({
    memoryTools: input.memoryTools,
    repoKey: input.repoKey,
    runId: input.runId,
    iteration: input.iteration,
    actor: input.actor,
  });
  const recentSessionMessages = input.dataDir && input.sessionStream
    ? await readSessionHistory({
        dataDir: input.dataDir,
        sessionStream: input.sessionStream,
        limit: input.recentLimit ?? 12,
      })
    : [];
  const sessionRecall = input.dataDir
    && input.repoKey
    && input.profileId
    && input.query?.trim()
    ? await searchSessionHistory({
        dataDir: input.dataDir,
        query: input.query,
        repoKey: input.repoKey,
        profileId: input.profileId,
        limit: input.recallLimit ?? 3,
        excludeMessageIds: recentSessionMessages.map((message) => message.messageId),
      })
    : [];
  return {
    userPreferences,
    recentSessionMessages,
    sessionRecall,
  };
};
