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

export type ReceiptDb = {
  readonly path: string;
  readonly sqlite: Database;
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;
};

const registry = new Map<string, ReceiptDb>();

const applyPragmas = (sqlite: Database): void => {
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
};

const applyMigrations = (sqlite: Database): void => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  if (!fs.existsSync(MIGRATIONS_DIR)) return;
  const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const applied = new Set<string>(
    sqlite.query("SELECT name FROM schema_migrations ORDER BY name").all().map((row) => String((row as { readonly name: unknown }).name)),
  );
  for (const file of migrationFiles) {
    if (applied.has(file)) continue;
    const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const tx = sqlite.transaction(() => {
      sqlite.exec(sqlText);
      sqlite.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(file, Date.now());
    });
    tx();
  }
};

const legacyJsonlPresent = (dataDir: string): boolean => {
  const manifest = path.join(dataDir, "_streams.json");
  if (fs.existsSync(manifest)) return true;
  try {
    return fs.readdirSync(dataDir).some((entry) => entry.endsWith(".jsonl"));
  } catch {
    return false;
  }
};

export const resolveReceiptDbPath = (dataDir: string, explicitPath?: string): string =>
  path.resolve(explicitPath?.trim() || process.env.RECEIPT_DB_PATH?.trim() || path.join(dataDir, DEFAULT_DB_FILE));

export const getReceiptDb = (
  dataDir: string,
  options: {
    readonly dbPath?: string;
    readonly allowLegacyImportHint?: boolean;
  } = {},
): ReceiptDb => {
  const dbPath = resolveReceiptDbPath(dataDir, options.dbPath);
  const cached = registry.get(dbPath);
  if (cached) return cached;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const exists = fs.existsSync(dbPath);
  if (!exists && !options.allowLegacyImportHint && legacyJsonlPresent(dataDir)) {
    throw new Error(
      `legacy JSONL data detected in ${dataDir}. Run 'receipt migrate sqlite --data-dir ${JSON.stringify(dataDir)}' before starting the runtime.`,
    );
  }

  const sqlite = new Database(dbPath, { create: true });
  applyPragmas(sqlite);
  applyMigrations(sqlite);
  const orm = drizzle(sqlite, { schema });
  const db = { path: dbPath, sqlite, orm } satisfies ReceiptDb;
  registry.set(dbPath, db);
  return db;
};

export const clearReceiptDb = (db: ReceiptDb): void => {
  db.sqlite.exec(`
    DELETE FROM change_log;
    DELETE FROM projection_offsets;
    DELETE FROM job_pending_commands;
    DELETE FROM job_projection;
    DELETE FROM objective_projection;
    DELETE FROM memory_accesses;
    DELETE FROM memory_entries;
    DELETE FROM branches;
    DELETE FROM receipts;
    DELETE FROM streams;
  `);
};

export const latestGlobalSeq = (db: ReceiptDb): number =>
  Number(
    db.orm.select({ value: max(schema.receipts.globalSeq) }).from(schema.receipts).get()?.value
      ?? 0,
  );

export const getProjectionOffset = (db: ReceiptDb, projector: string): number =>
  Number(
    db.orm.select({ value: schema.projectionOffsets.lastGlobalSeq })
      .from(schema.projectionOffsets)
      .where(eq(schema.projectionOffsets.projector, projector))
      .get()?.value ?? 0,
  );

export const setProjectionOffset = (db: ReceiptDb, projector: string, lastGlobalSeq: number): void => {
  db.sqlite.query(`
    INSERT INTO projection_offsets (projector, last_global_seq, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(projector) DO UPDATE SET
      last_global_seq = excluded.last_global_seq,
      updated_at = excluded.updated_at
  `).run(projector, lastGlobalSeq, Date.now());
};

export const listChangedStreams = (
  db: ReceiptDb,
  input: {
    readonly afterGlobalSeq: number;
    readonly streamPrefix?: string;
  },
): ReadonlyArray<{ readonly stream: string; readonly lastGlobalSeq: number }> => {
  const prefix = input.streamPrefix?.trim();
  const rows = prefix
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
      .all();
  return rows.map((row) => ({
    stream: row.stream,
    lastGlobalSeq: Number(row.lastGlobalSeq ?? 0),
  }));
};

export const listStreamsByPrefix = (db: ReceiptDb, prefix?: string): ReadonlyArray<string> => {
  const rows = prefix
    ? db.orm.select({ name: schema.streams.name })
      .from(schema.streams)
      .where(like(schema.streams.name, `${prefix}%`))
      .orderBy(schema.streams.name)
      .all()
    : db.orm.select({ name: schema.streams.name })
      .from(schema.streams)
      .orderBy(schema.streams.name)
      .all();
  return rows.map((row) => row.name);
};

export const hasLegacyJsonlData = (dataDir: string): boolean =>
  legacyJsonlPresent(dataDir);

export const pollLatestChangeSeq = (db: ReceiptDb): number =>
  Number(
    db.orm.select({ value: max(schema.changeLog.seq) }).from(schema.changeLog).get()?.value
      ?? 0,
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
  db.orm.select({
    seq: schema.changeLog.seq,
    globalSeq: schema.changeLog.globalSeq,
    stream: schema.changeLog.stream,
    eventType: schema.changeLog.eventType,
    changedAt: schema.changeLog.changedAt,
  })
    .from(schema.changeLog)
    .where(gt(schema.changeLog.seq, afterSeq))
    .orderBy(schema.changeLog.seq)
    .all()
    .map((row) => ({
      seq: Number(row.seq),
      globalSeq: Number(row.globalSeq),
      stream: row.stream,
      eventType: row.eventType,
      changedAt: Number(row.changedAt),
    }));

