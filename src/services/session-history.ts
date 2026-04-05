import { getReceiptDb } from "../db/client";
import { jsonParse } from "../db/json";
import { syncChangedChatContextProjections, syncChatContextProjectionStream } from "../db/projectors";
import type { FactoryChatContextSourceRef } from "../agents/factory/chat-context";

export type SessionHistoryMessage = {
  readonly messageId: string;
  readonly sessionStream: string;
  readonly chatId: string;
  readonly profileId: string;
  readonly repoKey: string;
  readonly runId: string;
  readonly role: string;
  readonly text: string;
  readonly ts: number;
  readonly orderKey: number;
  readonly receiptRefs: ReadonlyArray<FactoryChatContextSourceRef>;
};

export type SessionSearchResult = SessionHistoryMessage & {
  readonly score: number;
  readonly snippet: string;
};

export type SessionSearchInput = {
  readonly dataDir: string;
  readonly query: string;
  readonly repoKey?: string;
  readonly profileId?: string;
  readonly sessionStream?: string;
  readonly limit?: number;
  readonly excludeMessageIds?: ReadonlyArray<string>;
};

export type SessionReadInput = {
  readonly dataDir: string;
  readonly sessionStream?: string;
  readonly chatId?: string;
  readonly limit?: number;
};

const toSessionMessage = (row: {
  readonly messageId: string;
  readonly sessionStream: string;
  readonly chatId: string;
  readonly profileId: string;
  readonly repoKey: string;
  readonly runId: string;
  readonly role: string;
  readonly text: string;
  readonly ts: number;
  readonly orderKey: number;
  readonly receiptRefsJson: string;
}): SessionHistoryMessage => ({
  messageId: row.messageId,
  sessionStream: row.sessionStream,
  chatId: row.chatId,
  profileId: row.profileId,
  repoKey: row.repoKey,
  runId: row.runId,
  role: row.role,
  text: row.text,
  ts: Number(row.ts),
  orderKey: Number(row.orderKey),
  receiptRefs: jsonParse<ReadonlyArray<FactoryChatContextSourceRef>>(row.receiptRefsJson, []),
});

const normalizeFtsQuery = (query: string): string | undefined => {
  const stopWords = new Set([
    "a", "an", "and", "are", "again", "at", "be", "do", "for", "how", "i", "if", "in", "is", "it",
    "me", "of", "on", "or", "please", "should", "tell", "that", "the", "to", "use", "was", "what",
    "when", "where", "which", "who", "why", "with",
  ]);
  const terms = (query.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !stopWords.has(term))
    .slice(0, 8);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `${term}*`).join(" OR ");
};

const resolveSessionStream = async (dataDir: string, input: {
  readonly sessionStream?: string;
  readonly chatId?: string;
}): Promise<string | undefined> => {
  if (input.sessionStream?.trim()) {
    await syncChatContextProjectionStream(dataDir, input.sessionStream.trim());
    return input.sessionStream.trim();
  }
  if (!input.chatId?.trim()) return undefined;
  await syncChangedChatContextProjections(dataDir);
  const db = getReceiptDb(dataDir);
  const row = db.read(() => db.sqlite.query(`
    SELECT stream
    FROM chat_context_projection
    WHERE chat_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(input.chatId.trim()) as { readonly stream?: string } | null);
  return row?.stream?.trim() || undefined;
};

export const readSessionHistory = async (input: SessionReadInput): Promise<ReadonlyArray<SessionHistoryMessage>> => {
  const sessionStream = await resolveSessionStream(input.dataDir, input);
  if (!sessionStream) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
  const db = getReceiptDb(input.dataDir);
  const rows = db.read(() => db.sqlite.query(`
    SELECT
      message_id AS messageId,
      session_stream AS sessionStream,
      chat_id AS chatId,
      profile_id AS profileId,
      repo_key AS repoKey,
      run_id AS runId,
      role,
      text,
      ts,
      order_key AS orderKey,
      receipt_refs_json AS receiptRefsJson
    FROM session_messages
    WHERE session_stream = ?
    ORDER BY order_key ASC, ts ASC
    LIMIT ?
  `).all(sessionStream, limit) as ReadonlyArray<{
    readonly messageId: string;
    readonly sessionStream: string;
    readonly chatId: string;
    readonly profileId: string;
    readonly repoKey: string;
    readonly runId: string;
    readonly role: string;
    readonly text: string;
    readonly ts: number;
    readonly orderKey: number;
    readonly receiptRefsJson: string;
  }>);
  return rows.map(toSessionMessage);
};

export const searchSessionHistory = async (input: SessionSearchInput): Promise<ReadonlyArray<SessionSearchResult>> => {
  const ftsQuery = normalizeFtsQuery(input.query);
  if (!ftsQuery) return [];
  await syncChangedChatContextProjections(input.dataDir);
  const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
  const db = getReceiptDb(input.dataDir);
  const where = ["session_messages_fts MATCH ?"];
  const params: unknown[] = [ftsQuery];
  if (input.repoKey?.trim()) {
    where.push("sm.repo_key = ?");
    params.push(input.repoKey.trim());
  }
  if (input.profileId?.trim()) {
    where.push("sm.profile_id = ?");
    params.push(input.profileId.trim());
  }
  if (input.sessionStream?.trim()) {
    where.push("sm.session_stream = ?");
    params.push(input.sessionStream.trim());
  }
  const excluded = [...new Set((input.excludeMessageIds ?? []).map((value) => value.trim()).filter(Boolean))];
  if (excluded.length > 0) {
    where.push(`sm.message_id NOT IN (${excluded.map(() => "?").join(", ")})`);
    params.push(...excluded);
  }
  params.push(limit);
  const rows = db.read(() => db.sqlite.query(`
    SELECT
      sm.message_id AS messageId,
      sm.session_stream AS sessionStream,
      sm.chat_id AS chatId,
      sm.profile_id AS profileId,
      sm.repo_key AS repoKey,
      sm.run_id AS runId,
      sm.role AS role,
      sm.text AS text,
      sm.ts AS ts,
      sm.order_key AS orderKey,
      sm.receipt_refs_json AS receiptRefsJson,
      bm25(session_messages_fts) AS score,
      snippet(session_messages_fts, 0, '[', ']', ' … ', 12) AS snippet
    FROM session_messages_fts
    JOIN session_messages sm ON sm.rowid = session_messages_fts.rowid
    WHERE ${where.join(" AND ")}
    ORDER BY score ASC, sm.ts DESC
    LIMIT ?
  `).all(...params) as ReadonlyArray<{
    readonly messageId: string;
    readonly sessionStream: string;
    readonly chatId: string;
    readonly profileId: string;
    readonly repoKey: string;
    readonly runId: string;
    readonly role: string;
    readonly text: string;
    readonly ts: number;
    readonly orderKey: number;
    readonly receiptRefsJson: string;
    readonly score: number;
    readonly snippet: string | null;
  }>);
  return rows.map((row) => ({
    ...toSessionMessage(row),
    score: Number(row.score),
    snippet: row.snippet?.trim() || row.text,
  }));
};
