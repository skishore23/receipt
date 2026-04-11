import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

import type {
  ActivityRunInput,
  ActivitySnapshot,
  ActivityStatus,
  DurableBackend,
  ExecutionKey,
  SignalEnvelope,
  StartWorkflowInput,
  WorkflowSnapshot,
  WorkflowStatus,
} from "./contract";

type SqliteDatabase = Database;

type LocalDurableBackendOptions = {
  readonly dbPath: string;
};

const DEFAULT_BUSY_TIMEOUT_MS = 30_000;

const safeParseRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed rows and treat them as missing structured payloads.
  }
  return undefined;
};

const encodeJson = (value: Record<string, unknown> | undefined): string | null =>
  value ? JSON.stringify(value) : null;

const decodeWorkflow = (row: Record<string, unknown> | null | undefined): WorkflowSnapshot | undefined => {
  if (!row) return undefined;
  return {
    key: String(row.key),
    status: String(row.status) as WorkflowStatus,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at == null ? undefined : Number(row.started_at),
    completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
    lastSignalAt: row.last_signal_at == null ? undefined : Number(row.last_signal_at),
    input: safeParseRecord(row.input_json),
    metadata: safeParseRecord(row.metadata_json),
    output: safeParseRecord(row.output_json),
    error: typeof row.error_text === "string" && row.error_text.length > 0 ? row.error_text : undefined,
  };
};

const decodeSignal = (row: Record<string, unknown>): SignalEnvelope => ({
  id: String(row.id),
  workflowKey: String(row.workflow_key),
  seq: Number(row.seq),
  signal: String(row.signal),
  payload: safeParseRecord(row.payload_json),
  by: typeof row.by === "string" && row.by.length > 0 ? row.by : undefined,
  createdAt: Number(row.created_at),
  consumedAt: row.consumed_at == null ? undefined : Number(row.consumed_at),
});

const decodeActivity = (row: Record<string, unknown> | null | undefined): ActivitySnapshot | undefined => {
  if (!row) return undefined;
  return {
    key: String(row.key),
    status: String(row.status) as ActivityStatus,
    attempts: Number(row.attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at == null ? undefined : Number(row.started_at),
    completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
    input: safeParseRecord(row.input_json),
    metadata: safeParseRecord(row.metadata_json),
    output: safeParseRecord(row.output_json),
    error: typeof row.error_text === "string" && row.error_text.length > 0 ? row.error_text : undefined,
  };
};

const createTables = (db: SqliteDatabase): void => {
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_workflow (
      key TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      input_json TEXT,
      metadata_json TEXT,
      output_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_signal_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS durable_signal (
      id TEXT PRIMARY KEY NOT NULL,
      workflow_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      signal TEXT NOT NULL,
      payload_json TEXT,
      by TEXT,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS durable_signal_workflow_seq_uq
      ON durable_signal(workflow_key, seq);

    CREATE INDEX IF NOT EXISTS durable_signal_workflow_created_idx
      ON durable_signal(workflow_key, created_at);

    CREATE TABLE IF NOT EXISTS durable_activity (
      key TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      input_json TEXT,
      metadata_json TEXT,
      output_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS durable_activity_attempt (
      id TEXT PRIMARY KEY NOT NULL,
      activity_key TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT,
      error_text TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS durable_activity_attempt_uq
      ON durable_activity_attempt(activity_key, attempt);
  `);
};

const cloneRecord = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : undefined;

export const createLocalDurableBackend = (
  opts: LocalDurableBackendOptions,
): DurableBackend => {
  const db = new Database(opts.dbPath, { create: true });
  createTables(db);

  const transaction = <T>(work: () => T): T => {
    const wrapped = db.transaction(work);
    return wrapped();
  };

  const getWorkflowRow = (key: ExecutionKey): Record<string, unknown> | undefined =>
    db.query("SELECT * FROM durable_workflow WHERE key = ?").get(key) as
      | Record<string, unknown>
      | undefined;

  const getActivityRow = (key: ExecutionKey): Record<string, unknown> | undefined =>
    db.query("SELECT * FROM durable_activity WHERE key = ?").get(key) as
      | Record<string, unknown>
      | undefined;

  const upsertWorkflow = (input: StartWorkflowInput): WorkflowSnapshot =>
    transaction(() => {
      const now = Date.now();
      const existing = decodeWorkflow(getWorkflowRow(input.key));
      if (!existing) {
        db.query(`
          INSERT INTO durable_workflow (
            key, status, revision, input_json, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.key,
          "pending",
          1,
          encodeJson(cloneRecord(input.input)),
          encodeJson(cloneRecord(input.metadata)),
          now,
          now,
        );
        return decodeWorkflow(getWorkflowRow(input.key))!;
      }
      if (existing.status === "pending" || existing.status === "running") return existing;
      db.query(`
        UPDATE durable_workflow
        SET status = ?, revision = ?, updated_at = ?, started_at = NULL, completed_at = NULL, output_json = NULL,
            error_text = NULL, input_json = COALESCE(?, input_json), metadata_json = COALESCE(?, metadata_json)
        WHERE key = ?
      `).run(
        "pending",
        existing.revision + 1,
        now,
        encodeJson(cloneRecord(input.input)),
        encodeJson(cloneRecord(input.metadata)),
        input.key,
      );
      return decodeWorkflow(getWorkflowRow(input.key))!;
    });

  const listSignalsForKey = (key: ExecutionKey): ReadonlyArray<SignalEnvelope> =>
    (db.query(
      "SELECT * FROM durable_signal WHERE workflow_key = ? ORDER BY seq ASC",
    ).all(key) as Record<string, unknown>[]).map(decodeSignal);

  return {
    startOrResumeWorkflow: async (input) => upsertWorkflow(input),
    signalWorkflow: async (input) =>
      transaction(() => {
        const workflow = upsertWorkflow({
          key: input.key,
        });
        const now = Date.now();
        const nextSeqRow = db.query(
          "SELECT COALESCE(MAX(seq), 0) AS value FROM durable_signal WHERE workflow_key = ?",
        ).get(input.key) as { readonly value: number };
        const signal: SignalEnvelope = {
          id: `sig_${randomUUID()}`,
          workflowKey: input.key,
          seq: Number(nextSeqRow.value) + 1,
          signal: input.signal,
          payload: cloneRecord(input.payload),
          by: input.by,
          createdAt: now,
        };
        db.query(`
          INSERT INTO durable_signal (
            id, workflow_key, seq, signal, payload_json, by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          signal.id,
          signal.workflowKey,
          signal.seq,
          signal.signal,
          encodeJson(signal.payload),
          signal.by ?? null,
          signal.createdAt,
        );
        db.query(`
          UPDATE durable_workflow
          SET revision = ?, updated_at = ?, last_signal_at = ?, status = ?
          WHERE key = ?
        `).run(
          workflow.revision + 1,
          now,
          now,
          workflow.status === "running" ? "running" : "pending",
          input.key,
        );
        return signal;
      }),
    consumeWorkflowSignals: async (input) =>
      transaction(() => {
        const rows = db.query(`
          SELECT * FROM durable_signal
          WHERE workflow_key = ?
            AND consumed_at IS NULL
          ORDER BY seq ASC
        `).all(input.key) as Record<string, unknown>[];
        const filtered = rows
          .map(decodeSignal)
          .filter((row) => !input.signals || input.signals.length === 0 || input.signals.includes(row.signal))
          .slice(0, Math.max(1, input.limit ?? 100));
        if (filtered.length === 0) return [] as SignalEnvelope[];
        const now = Date.now();
        for (const signal of filtered) {
          db.query("UPDATE durable_signal SET consumed_at = ? WHERE id = ?").run(now, signal.id);
        }
        db.query(`
          UPDATE durable_workflow
          SET revision = revision + 1, updated_at = ?, status = CASE
            WHEN status = 'canceled' THEN status
            WHEN status = 'completed' THEN status
            WHEN status = 'failed' THEN status
            ELSE 'running'
          END
          WHERE key = ?
        `).run(now, input.key);
        return filtered.map((signal) => ({
          ...signal,
          consumedAt: now,
        }));
      }),
    listWorkflowSignals: async (key) => listSignalsForKey(key),
    setWorkflowStatus: async (input) =>
      transaction(() => {
        const existing = decodeWorkflow(getWorkflowRow(input.key));
        if (!existing) return undefined;
        const now = Date.now();
        db.query(`
          UPDATE durable_workflow
          SET status = ?, revision = ?, updated_at = ?, started_at = CASE
                WHEN ? = 'running' AND started_at IS NULL THEN ?
                ELSE started_at
              END,
              completed_at = CASE
                WHEN ? IN ('completed', 'failed', 'canceled', 'idle') THEN ?
                ELSE completed_at
              END,
              output_json = COALESCE(?, output_json),
              error_text = COALESCE(?, error_text),
              metadata_json = COALESCE(?, metadata_json)
          WHERE key = ?
        `).run(
          input.status,
          existing.revision + 1,
          now,
          input.status,
          now,
          input.status,
          input.status === "running" ? null : now,
          encodeJson(cloneRecord(input.output)),
          input.error ?? null,
          encodeJson(cloneRecord(input.metadata)),
          input.key,
        );
        return decodeWorkflow(getWorkflowRow(input.key));
      }),
    cancelWorkflow: async (key, reason) =>
      transaction(() => {
        const existing = decodeWorkflow(getWorkflowRow(key));
        if (!existing) return undefined;
        const now = Date.now();
        db.query(`
          UPDATE durable_workflow
          SET status = ?, revision = ?, updated_at = ?, completed_at = ?, error_text = COALESCE(?, error_text)
          WHERE key = ?
        `).run("canceled", existing.revision + 1, now, now, reason ?? null, key);
        return decodeWorkflow(getWorkflowRow(key));
      }),
    getWorkflow: async (key) => decodeWorkflow(getWorkflowRow(key)),
    listWorkflows: async (opts) => {
      const rows = db.query("SELECT * FROM durable_workflow ORDER BY key ASC").all() as Record<string, unknown>[];
      const statuses = opts?.statuses ? new Set(opts.statuses) : undefined;
      const prefix = opts?.prefix?.trim();
      return rows
        .map(decodeWorkflow)
        .filter((row): row is WorkflowSnapshot => Boolean(row))
        .filter((row) => !prefix || row.key.startsWith(prefix))
        .filter((row) => !statuses || statuses.has(row.status));
    },
    waitForWorkflowChange: async (input) => {
      const timeoutMs = Math.max(0, input.timeoutMs ?? 5_000);
      const pollMs = Math.max(10, input.pollMs ?? 100);
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        const snapshot = decodeWorkflow(getWorkflowRow(input.key));
        if (!snapshot) return undefined;
        if (snapshot.revision !== (input.sinceRevision ?? snapshot.revision - 1)) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return decodeWorkflow(getWorkflowRow(input.key));
    },
    getActivity: async (key) => decodeActivity(getActivityRow(key)),
    listActivities: async (opts) => {
      const rows = db.query("SELECT * FROM durable_activity ORDER BY key ASC").all() as Record<string, unknown>[];
      const statuses = opts?.statuses ? new Set(opts.statuses) : undefined;
      const prefix = opts?.prefix?.trim();
      return rows
        .map(decodeActivity)
        .filter((row): row is ActivitySnapshot => Boolean(row))
        .filter((row) => !prefix || row.key.startsWith(prefix))
        .filter((row) => !statuses || statuses.has(row.status));
    },
    runDurableActivity: async <Result extends Record<string, unknown>>(input: ActivityRunInput<Result>) => {
      const existing = decodeActivity(getActivityRow(input.key));
      if (existing?.status === "completed" && existing.output) {
        return {
          snapshot: existing,
          result: cloneRecord(existing.output) as Result,
        };
      }

      const recovered = await input.recover?.();
      if (recovered) {
        const now = Date.now();
        transaction(() => {
          const prior = decodeActivity(getActivityRow(input.key));
          if (!prior) {
            db.query(`
              INSERT INTO durable_activity (
                key, status, attempts, input_json, metadata_json, output_json, created_at, updated_at, started_at, completed_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              input.key,
              "completed",
              0,
              encodeJson(cloneRecord(input.input)),
              encodeJson(cloneRecord(input.metadata)),
              encodeJson(cloneRecord(recovered)),
              now,
              now,
              now,
              now,
            );
          } else {
            db.query(`
              UPDATE durable_activity
              SET status = ?, updated_at = ?, completed_at = ?, output_json = ?, metadata_json = COALESCE(?, metadata_json)
              WHERE key = ?
            `).run(
              "completed",
              now,
              now,
              encodeJson(cloneRecord(recovered)),
              encodeJson(cloneRecord(input.metadata)),
              input.key,
            );
          }
        });
        const snapshot = decodeActivity(getActivityRow(input.key))!;
        return { snapshot, result: recovered };
      }

      transaction(() => {
        const now = Date.now();
        const current = decodeActivity(getActivityRow(input.key));
        const attempts = (current?.attempts ?? 0) + 1;
        if (!current) {
          db.query(`
            INSERT INTO durable_activity (
              key, status, attempts, input_json, metadata_json, created_at, updated_at, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.key,
            "running",
            attempts,
            encodeJson(cloneRecord(input.input)),
            encodeJson(cloneRecord(input.metadata)),
            now,
            now,
            now,
          );
        } else {
          db.query(`
            UPDATE durable_activity
            SET status = ?, attempts = ?, updated_at = ?, started_at = ?, completed_at = NULL, output_json = NULL,
                error_text = NULL, input_json = COALESCE(?, input_json), metadata_json = COALESCE(?, metadata_json)
            WHERE key = ?
          `).run(
            "running",
            attempts,
            now,
            now,
            encodeJson(cloneRecord(input.input)),
            encodeJson(cloneRecord(input.metadata)),
            input.key,
          );
        }
        db.query(`
          INSERT INTO durable_activity_attempt (
            id, activity_key, attempt, status, metadata_json, started_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          `attempt_${randomUUID()}`,
          input.key,
          attempts,
          "running",
          encodeJson(cloneRecord(input.metadata)),
          now,
        );
      });

      try {
        const result = await input.run();
        const now = Date.now();
        transaction(() => {
          const current = decodeActivity(getActivityRow(input.key))!;
          db.query(`
            UPDATE durable_activity
            SET status = ?, updated_at = ?, completed_at = ?, output_json = ?
            WHERE key = ?
          `).run(
            "completed",
            now,
            now,
            encodeJson(cloneRecord(result)),
            input.key,
          );
          db.query(`
            UPDATE durable_activity_attempt
            SET status = ?, completed_at = ?
            WHERE activity_key = ? AND attempt = ?
          `).run(
            "completed",
            now,
            input.key,
            current.attempts,
          );
        });
        return {
          snapshot: decodeActivity(getActivityRow(input.key))!,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const now = Date.now();
        transaction(() => {
          const current = decodeActivity(getActivityRow(input.key))!;
          db.query(`
            UPDATE durable_activity
            SET status = ?, updated_at = ?, completed_at = ?, error_text = ?
            WHERE key = ?
          `).run(
            "failed",
            now,
            now,
            message,
            input.key,
          );
          db.query(`
            UPDATE durable_activity_attempt
            SET status = ?, completed_at = ?, error_text = ?
            WHERE activity_key = ? AND attempt = ?
          `).run(
            "failed",
            now,
            message,
            input.key,
            current.attempts,
          );
        });
        throw error;
      }
    },
  };
};
