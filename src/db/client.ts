import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";
import { and, desc, eq, gt, like, max, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, "../../drizzle");
const DEFAULT_DB_FILE = "receipt.db";
const SQLITE_LOCK_RE = /\b(database is locked|database is busy|sqlite_busy|sqlite_locked|sqlite_busy_snapshot|SQLITE_BUSY|SQLITE_LOCKED)\b/i;
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 30_000;
const DEFAULT_SQLITE_LOCK_RETRY_ATTEMPTS = 8;
const DEFAULT_SQLITE_LOCK_RETRY_BASE_MS = 25;
const DEFAULT_SQLITE_LOCK_RETRY_MAX_DELAY_MS = 250;
const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1_000;
const DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const SQLITE_SLEEP_BUFFER = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
const SQLITE_SLEEP_STATE = new Int32Array(SQLITE_SLEEP_BUFFER);

export type ReceiptDb = {
  readonly path: string;
  readonly sqlite: Database;
  readonly orm: ReceiptOrm;
  readonly read: <T>(work: () => T) => T;
  readonly write: <T>(work: () => T) => T;
  readonly transaction: <T>(work: (tx: ReceiptDbTransaction) => T) => T;
};

type ReceiptOrm = ReturnType<typeof drizzle<typeof schema>>;
export type ReceiptDbTransaction =
  Parameters<ReceiptOrm["transaction"]>[0] extends (tx: infer Tx) => unknown
    ? Tx
    : never;

const registry = new Map<string, ReceiptDb>();

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const SQLITE_BUSY_TIMEOUT_MS = parsePositiveInt(
  process.env.RECEIPT_SQLITE_BUSY_TIMEOUT_MS,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
);
const SQLITE_LOCK_RETRY_ATTEMPTS = parsePositiveInt(
  process.env.RECEIPT_SQLITE_LOCK_RETRY_ATTEMPTS,
  DEFAULT_SQLITE_LOCK_RETRY_ATTEMPTS,
);
const SQLITE_LOCK_RETRY_BASE_MS = parsePositiveInt(
  process.env.RECEIPT_SQLITE_LOCK_RETRY_BASE_MS,
  DEFAULT_SQLITE_LOCK_RETRY_BASE_MS,
);
const SQLITE_LOCK_RETRY_MAX_DELAY_MS = parsePositiveInt(
  process.env.RECEIPT_SQLITE_LOCK_RETRY_MAX_DELAY_MS,
  DEFAULT_SQLITE_LOCK_RETRY_MAX_DELAY_MS,
);
const SQLITE_WAL_AUTOCHECKPOINT_PAGES = parsePositiveInt(
  process.env.RECEIPT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
);
const SQLITE_JOURNAL_SIZE_LIMIT_BYTES = parsePositiveInt(
  process.env.RECEIPT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
  DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES,
);

const sleepSync = (delayMs: number): void => {
  if (delayMs <= 0) return;
  Atomics.wait(SQLITE_SLEEP_STATE, 0, 0, delayMs);
};

const sqliteLockRetryDelayMs = (attempt: number): number =>
  Math.min(
    SQLITE_LOCK_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
    SQLITE_LOCK_RETRY_MAX_DELAY_MS,
  );

export const isSqliteLockError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SQLITE_LOCK_RE.test(message);
};

export const withSqliteLockRetry = <T>(work: () => T): T => {
  let attempt = 0;
  while (true) {
    try {
      return work();
    } catch (error) {
      if (!isSqliteLockError(error) || attempt >= SQLITE_LOCK_RETRY_ATTEMPTS) {
        throw error;
      }
      attempt += 1;
      sleepSync(sqliteLockRetryDelayMs(attempt));
    }
  }
};

const applyPragmas = (sqlite: Database): void => {
  withSqliteLockRetry(() => {
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec("PRAGMA synchronous = NORMAL;");
    sqlite.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES};`);
    sqlite.exec("PRAGMA temp_store = MEMORY;");
    sqlite.exec(`PRAGMA journal_size_limit = ${SQLITE_JOURNAL_SIZE_LIMIT_BYTES};`);
  });
};

const applyMigrations = (sqlite: Database): void => {
  withSqliteLockRetry(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
  });
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const applied = new Set<string>(
    withSqliteLockRetry(() => sqlite.query("SELECT name FROM schema_migrations ORDER BY name").all())
      .map((row) => String((row as { readonly name: unknown }).name)),
  );
  for (const file of migrationFiles) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const tx = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, Date.now());
    });
    withSqliteLockRetry(() => tx());
  }
};

export const resolveReceiptDbPath = (dataDir: string, explicitPath?: string): string =>
  path.resolve(explicitPath?.trim() || process.env.RECEIPT_DB_PATH?.trim() || path.join(dataDir, DEFAULT_DB_FILE));

export const getReceiptDb = (
  dataDir: string,
  options: {
    readonly dbPath?: string;
  } = {},
): ReceiptDb => {
  const dbPath = resolveReceiptDbPath(dataDir, options.dbPath);
  const cached = registry.get(dbPath);
  if (cached) return cached;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath, { create: true });
  applyPragmas(sqlite);
  applyMigrations(sqlite);
  const orm = drizzle(sqlite, { schema });
  const db = {
    path: dbPath,
    sqlite,
    orm,
    read: <T>(work: () => T): T => withSqliteLockRetry(work),
    write: <T>(work: () => T): T => withSqliteLockRetry(work),
    transaction: <T>(work: (tx: ReceiptDbTransaction) => T): T =>
      withSqliteLockRetry(() => orm.transaction((tx) => work(tx))),
  } satisfies ReceiptDb;
  registry.set(dbPath, db);
  return db;
};

export const clearReceiptDb = (db: ReceiptDb): void => {
  db.transaction((tx) => {
    tx.delete(schema.changeLog).run();
    tx.delete(schema.projectionOffsets).run();
    tx.delete(schema.jobPendingCommands).run();
    tx.delete(schema.jobProjection).run();
    tx.delete(schema.objectiveProjection).run();
    tx.delete(schema.chatContextProjection).run();
    tx.delete(schema.memoryAccesses).run();
    tx.delete(schema.memoryEntries).run();
    tx.delete(schema.branches).run();
    tx.delete(schema.receipts).run();
    tx.delete(schema.streams).run();
  });
};

export const latestGlobalSeq = (db: ReceiptDb): number =>
  Number(
    db.read(() => db.orm.select({ value: max(schema.receipts.globalSeq) }).from(schema.receipts).get())?.value
      ?? 0,
  );

export const getProjectionOffset = (db: ReceiptDb, projector: string): number =>
  Number(
    db.read(() => db.orm.select({ value: schema.projectionOffsets.lastGlobalSeq })
      .from(schema.projectionOffsets)
      .where(eq(schema.projectionOffsets.projector, projector))
      .get())?.value ?? 0,
  );

export const setProjectionOffset = (db: ReceiptDb, projector: string, lastGlobalSeq: number): void => {
  const updatedAt = Date.now();
  db.write(() => {
    db.orm.insert(schema.projectionOffsets)
      .values({
        projector,
        lastGlobalSeq,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.projectionOffsets.projector,
        set: {
          lastGlobalSeq,
          updatedAt,
        },
      })
      .run();
  });
};

export const listChangedStreams = (
  db: ReceiptDb,
  input: {
    readonly afterGlobalSeq: number;
    readonly streamPrefix?: string;
  },
): ReadonlyArray<{ readonly stream: string; readonly lastGlobalSeq: number }> => {
  const prefix = input.streamPrefix?.trim();
  const rows = db.read(() => (
    prefix
      ? db.orm.select({
          stream: schema.changeLog.stream,
          lastGlobalSeq: max(schema.changeLog.globalSeq),
        })
        .from(schema.changeLog)
        .where(and(
          gt(schema.changeLog.globalSeq, input.afterGlobalSeq),
          like(schema.changeLog.stream, `${prefix}%`),
        ))
        .groupBy(schema.changeLog.stream)
        .orderBy(sql`MAX(${schema.changeLog.globalSeq}) ASC`)
        .all()
      : db.orm.select({
          stream: schema.changeLog.stream,
          lastGlobalSeq: max(schema.changeLog.globalSeq),
        })
        .from(schema.changeLog)
        .where(gt(schema.changeLog.globalSeq, input.afterGlobalSeq))
        .groupBy(schema.changeLog.stream)
        .orderBy(sql`MAX(${schema.changeLog.globalSeq}) ASC`)
        .all()
  ));
  return rows.map((row) => ({
    stream: row.stream,
    lastGlobalSeq: Number(row.lastGlobalSeq ?? 0),
  }));
};

export const listStreamsByPrefix = (db: ReceiptDb, prefix?: string): ReadonlyArray<string> => {
  const rows = db.read(() => (
    prefix
      ? db.orm.select({ name: schema.streams.name })
        .from(schema.streams)
        .where(like(schema.streams.name, `${prefix}%`))
        .orderBy(schema.streams.name)
        .all()
      : db.orm.select({ name: schema.streams.name })
        .from(schema.streams)
        .orderBy(schema.streams.name)
        .all()
  ));
  return rows.map((row) => row.name);
};

export const pollLatestChangeSeq = (db: ReceiptDb): number =>
  Number(
    db.read(() => db.orm.select({ value: max(schema.changeLog.seq) }).from(schema.changeLog).get())?.value
      ?? 0,
  );

export const listReceiptStreams = (
  db: ReceiptDb,
): ReadonlyArray<{ readonly name: string; readonly receiptCount: number; readonly updatedAt: number }> =>
  db.read(() => db.orm.select({
    name: schema.streams.name,
    receiptCount: schema.streams.receiptCount,
    updatedAt: schema.streams.updatedAt,
  })
    .from(schema.streams)
    .orderBy(desc(schema.streams.updatedAt))
    .all())
    .map((row) => ({
      name: row.name,
      receiptCount: Number(row.receiptCount),
      updatedAt: Number(row.updatedAt),
    }));

export const readReceiptsByStream = (
  db: ReceiptDb,
  stream: string,
  opts?: { readonly order?: "asc" | "desc"; readonly limit?: number },
): ReadonlyArray<{
  readonly globalSeq: number;
  readonly streamSeq: number;
  readonly ts: number;
  readonly hash: string;
  readonly eventType: string;
  readonly bodyJson: string;
}> => {
  const order = opts?.order ?? "desc";
  const limit = opts?.limit ?? 200;
  const rows = db.read(() => db.orm.select({
    globalSeq: schema.receipts.globalSeq,
    streamSeq: schema.receipts.streamSeq,
    ts: schema.receipts.ts,
    hash: schema.receipts.hash,
    eventType: schema.receipts.eventType,
    bodyJson: schema.receipts.bodyJson,
  })
    .from(schema.receipts)
    .where(eq(schema.receipts.stream, stream))
    .orderBy(order === "desc" ? desc(schema.receipts.streamSeq) : schema.receipts.streamSeq)
    .limit(limit)
    .all());
  return rows.map((row) => ({
    globalSeq: Number(row.globalSeq),
    streamSeq: Number(row.streamSeq),
    ts: Number(row.ts),
    hash: row.hash,
    eventType: row.eventType,
    bodyJson: row.bodyJson,
  }));
};

export const countReceiptsInStream = (db: ReceiptDb, stream: string): number =>
  Number(
    db.read(() => db.orm.select({ value: sql<number>`count(*)` })
      .from(schema.receipts)
      .where(eq(schema.receipts.stream, stream))
      .get())?.value ?? 0,
  );

export const listChangesAfter = (
  db: ReceiptDb,
  afterSeq: number,
): ReadonlyArray<{
  readonly seq: number;
  readonly globalSeq: number;
  readonly stream: string;
  readonly eventType: string;
  readonly changedAt: number;
}> =>
  db.read(() => db.orm.select({
    seq: schema.changeLog.seq,
    globalSeq: schema.changeLog.globalSeq,
    stream: schema.changeLog.stream,
    eventType: schema.changeLog.eventType,
    changedAt: schema.changeLog.changedAt,
  })
    .from(schema.changeLog)
    .where(gt(schema.changeLog.seq, afterSeq))
    .orderBy(schema.changeLog.seq)
    .all())
    .map((row) => ({
      seq: Number(row.seq),
      globalSeq: Number(row.globalSeq),
      stream: row.stream,
      eventType: row.eventType,
      changedAt: Number(row.changedAt),
    }));
