import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

import type {
  ActivityCheckpointInput,
  ActivityCompletionInput,
  ActivityFailureInput,
  ActivityHeartbeatInput,
  ActivityRunInput,
  DurableActivityController,
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
  readonly busyTimeoutMs?: number;
};

const DEFAULT_BUSY_TIMEOUT_MS = 30_000;
const SQLITE_LOCK_RE =
  /\b(database is locked|database is busy|sqlite_busy|sqlite_locked|sqlite_busy_snapshot|SQLITE_BUSY|SQLITE_LOCKED)\b/i;
const DEFAULT_LOCK_RETRY_ATTEMPTS = 8;
const DEFAULT_LOCK_RETRY_BASE_MS = 25;
const DEFAULT_LOCK_RETRY_MAX_DELAY_MS = 250;
const SQLITE_SLEEP_BUFFER = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
const SQLITE_SLEEP_STATE = new Int32Array(SQLITE_SLEEP_BUFFER);

const sleepSync = (delayMs: number): void => {
  if (delayMs <= 0) return;
  Atomics.wait(SQLITE_SLEEP_STATE, 0, 0, delayMs);
};

const sqliteLockRetryDelayMs = (attempt: number): number =>
  Math.min(
    DEFAULT_LOCK_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
    DEFAULT_LOCK_RETRY_MAX_DELAY_MS,
  );

const isSqliteLockError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return SQLITE_LOCK_RE.test(message);
};

const withSqliteLockRetry = <T>(work: () => T): T => {
  let attempt = 0;
  while (true) {
    try {
      return work();
    } catch (error) {
      if (!isSqliteLockError(error) || attempt >= DEFAULT_LOCK_RETRY_ATTEMPTS) {
        throw error;
      }
      attempt += 1;
      sleepSync(sqliteLockRetryDelayMs(attempt));
    }
  }
};

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
    lastHeartbeatAt: row.last_heartbeat_at == null ? undefined : Number(row.last_heartbeat_at),
    checkpointRevision: row.checkpoint_revision == null ? 0 : Number(row.checkpoint_revision),
    checkpointOutput: safeParseRecord(row.checkpoint_output_json),
    checkpointMetadata: safeParseRecord(row.checkpoint_metadata_json),
    input: safeParseRecord(row.input_json),
    metadata: safeParseRecord(row.metadata_json),
    output: safeParseRecord(row.output_json),
    error: typeof row.error_text === "string" && row.error_text.length > 0 ? row.error_text : undefined,
  };
};

const createTables = (db: SqliteDatabase, busyTimeoutMs: number): void => {
  withSqliteLockRetry(() => {
    db.exec(`PRAGMA journal_mode = WAL;`);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
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
      checkpoint_revision INTEGER NOT NULL DEFAULT 0,
      input_json TEXT,
      metadata_json TEXT,
      output_json TEXT,
      checkpoint_output_json TEXT,
      checkpoint_metadata_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_heartbeat_at INTEGER
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

    const existingColumns = (
      db.query("PRAGMA table_info(durable_activity)").all() as Array<{ readonly name?: string }>
    ).map((row) => row.name).filter((value): value is string => typeof value === "string");
    const ensureColumn = (name: string, sql: string): void => {
      if (existingColumns.includes(name)) return;
      db.exec(`ALTER TABLE durable_activity ADD COLUMN ${sql};`);
    };
    ensureColumn("checkpoint_revision", "checkpoint_revision INTEGER NOT NULL DEFAULT 0");
    ensureColumn("checkpoint_output_json", "checkpoint_output_json TEXT");
    ensureColumn("checkpoint_metadata_json", "checkpoint_metadata_json TEXT");
    ensureColumn("last_heartbeat_at", "last_heartbeat_at INTEGER");
  });
};

const cloneRecord = (value: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
  value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : undefined;

export const createLocalDurableBackend = (
  opts: LocalDurableBackendOptions,
): DurableBackend => {
  const db = new Database(opts.dbPath, { create: true });
  createTables(db, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);

  const transaction = <T>(work: () => T): T => {
    return withSqliteLockRetry(() => {
      const wrapped = db.transaction(work);
      return wrapped();
    });
  };

  const getWorkflowRow = (key: ExecutionKey): Record<string, unknown> | undefined =>
    withSqliteLockRetry(() =>
      db.query("SELECT * FROM durable_workflow WHERE key = ?").get(key) as
        | Record<string, unknown>
        | undefined
    );

  const getActivityRow = (key: ExecutionKey): Record<string, unknown> | undefined =>
    withSqliteLockRetry(() =>
      db.query("SELECT * FROM durable_activity WHERE key = ?").get(key) as
        | Record<string, unknown>
        | undefined
    );

  const heartbeatActivityRow = (
    input: ActivityHeartbeatInput,
  ): ActivitySnapshot | undefined =>
    transaction(() => {
      const existing = decodeActivity(getActivityRow(input.key));
      if (!existing) return undefined;
      const now = Date.now();
      db.query(`
        UPDATE durable_activity
        SET updated_at = ?, last_heartbeat_at = ?, metadata_json = COALESCE(?, metadata_json)
        WHERE key = ?
      `).run(
        now,
        now,
        encodeJson(cloneRecord(input.metadata)),
        input.key,
      );
      return decodeActivity(getActivityRow(input.key));
    });

  const checkpointActivityRow = (
    input: ActivityCheckpointInput,
  ): ActivitySnapshot | undefined =>
    transaction(() => {
      const existing = decodeActivity(getActivityRow(input.key));
      if (!existing) return undefined;
      const now = Date.now();
      db.query(`
        UPDATE durable_activity
        SET updated_at = ?,
            last_heartbeat_at = ?,
            checkpoint_revision = checkpoint_revision + 1,
            checkpoint_output_json = COALESCE(?, checkpoint_output_json),
            checkpoint_metadata_json = COALESCE(?, checkpoint_metadata_json)
        WHERE key = ?
      `).run(
        now,
        now,
        encodeJson(cloneRecord(input.output)),
        encodeJson(cloneRecord(input.metadata)),
        input.key,
      );
      return decodeActivity(getActivityRow(input.key));
    });

  const completeActivityRow = (
    input: ActivityCompletionInput,
  ): ActivitySnapshot | undefined =>
    transaction(() => {
      const existing = decodeActivity(getActivityRow(input.key));
      if (!existing) return undefined;
      const now = Date.now();
      db.query(`
        UPDATE durable_activity
        SET status = ?,
            updated_at = ?,
            completed_at = ?,
            last_heartbeat_at = ?,
            output_json = COALESCE(?, output_json),
            metadata_json = COALESCE(?, metadata_json)
        WHERE key = ?
      `).run(
        "completed",
        now,
        now,
        now,
        encodeJson(cloneRecord(input.output)),
        encodeJson(cloneRecord(input.metadata)),
        input.key,
      );
      return decodeActivity(getActivityRow(input.key));
    });

  const failActivityRow = (
    input: ActivityFailureInput,
  ): ActivitySnapshot | undefined =>
    transaction(() => {
      const existing = decodeActivity(getActivityRow(input.key));
      if (!existing) return undefined;
      const now = Date.now();
      db.query(`
        UPDATE durable_activity
        SET status = ?,
            updated_at = ?,
            completed_at = ?,
            last_heartbeat_at = ?,
            error_text = ?,
            metadata_json = COALESCE(?, metadata_json)
        WHERE key = ?
      `).run(
        "failed",
        now,
        now,
        now,
        input.error,
        encodeJson(cloneRecord(input.metadata)),
        input.key,
      );
      return decodeActivity(getActivityRow(input.key));
    });

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
    withSqliteLockRetry(() =>
      (db.query(
        "SELECT * FROM durable_signal WHERE workflow_key = ? ORDER BY seq ASC",
      ).all(key) as Record<string, unknown>[]).map(decodeSignal)
    );

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
      const rows = withSqliteLockRetry(
        () => db.query("SELECT * FROM durable_workflow ORDER BY key ASC").all() as Record<string, unknown>[],
      );
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
    heartbeatActivity: async (input) => heartbeatActivityRow(input),
    checkpointActivity: async (input) => checkpointActivityRow(input),
    completeActivity: async (input) => completeActivityRow(input),
    failActivity: async (input) => failActivityRow(input),
    listActivities: async (opts) => {
      const rows = withSqliteLockRetry(
        () => db.query("SELECT * FROM durable_activity ORDER BY key ASC").all() as Record<string, unknown>[],
      );
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
        const prior = decodeActivity(getActivityRow(input.key));
        if (!prior) {
          const now = Date.now();
          transaction(() => {
            db.query(`
              INSERT INTO durable_activity (
                key, status, attempts, checkpoint_revision, input_json, metadata_json, output_json, created_at, updated_at, started_at, completed_at, last_heartbeat_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              input.key,
              "completed",
              0,
              0,
              encodeJson(cloneRecord(input.input)),
              encodeJson(cloneRecord(input.metadata)),
              encodeJson(cloneRecord(recovered)),
              now,
              now,
              now,
              now,
              now,
            );
          });
        } else {
          completeActivityRow({
            key: input.key,
            output: recovered,
            metadata: input.metadata,
          });
        }
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
              key, status, attempts, checkpoint_revision, input_json, metadata_json, created_at, updated_at, started_at, last_heartbeat_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.key,
            "running",
            attempts,
            0,
            encodeJson(cloneRecord(input.input)),
            encodeJson(cloneRecord(input.metadata)),
            now,
            now,
            now,
            now,
          );
        } else {
          db.query(`
            UPDATE durable_activity
            SET status = ?, attempts = ?, updated_at = ?, started_at = ?, completed_at = NULL, output_json = NULL,
                error_text = NULL, input_json = COALESCE(?, input_json), metadata_json = COALESCE(?, metadata_json),
                last_heartbeat_at = ?
            WHERE key = ?
          `).run(
            "running",
            attempts,
            now,
            now,
            encodeJson(cloneRecord(input.input)),
            encodeJson(cloneRecord(input.metadata)),
            now,
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
        const controller: DurableActivityController<Result> = {
          heartbeat: async (metadata) => heartbeatActivityRow({
            key: input.key,
            metadata,
          }),
          checkpoint: async (output, metadata) => checkpointActivityRow({
            key: input.key,
            output,
            metadata,
          }),
          complete: async (output, metadata) => completeActivityRow({
            key: input.key,
            output,
            metadata,
          }),
          fail: async (error, metadata) => failActivityRow({
            key: input.key,
            error,
            metadata,
          }),
          snapshot: async () => decodeActivity(getActivityRow(input.key)),
        };
        const result = await input.run(controller);
        const current = decodeActivity(getActivityRow(input.key))!;
        const now = Date.now();
        completeActivityRow({
          key: input.key,
          output: result,
        });
        transaction(() => {
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
        const current = decodeActivity(getActivityRow(input.key))!;
        const now = Date.now();
        failActivityRow({
          key: input.key,
          error: message,
        });
        transaction(() => {
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
