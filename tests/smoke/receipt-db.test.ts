import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getProjectionOffset, getReceiptDb, setProjectionOffset, withSqliteLockRetry } from "../../src/db/client";

const mkTmp = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const createLockHolderScript = (): string => `
  import { Database } from "bun:sqlite";

  const dbPath = process.env.DB_PATH;
  const holdMs = Number(process.env.HOLD_MS ?? "350");
  if (!dbPath) {
    console.error("missing DB_PATH");
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("BEGIN IMMEDIATE;");
  console.log("LOCKED");
  setTimeout(() => {
    try {
      db.exec("COMMIT;");
      db.close();
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    }
  }, holdMs);
`;

const holdWriterLock = async (
  dbPath: string,
  holdMs = 350,
): Promise<ReturnType<typeof spawn>> => {
  const child = spawn(process.execPath, ["-e", createLockHolderScript()], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      HOLD_MS: String(holdMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");

  let stdout = "";
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("LOCKED")) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`lock-holder exited before taking the writer lock (code ${code ?? "null"}): ${stderr.trim()}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
    child.on("error", onError);
  });

  return child;
};

test("db client: retries synthetic sqlite lock errors", () => {
  let attempts = 0;
  const value = withSqliteLockRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return "ok";
  });

  expect(value).toBe("ok");
  expect(attempts).toBe(3);
});

test("db client: raw sqlite statements survive a transient writer lock", async () => {
  const dir = await mkTmp("receipt-db-raw-lock");
  let lockHolder: ReturnType<typeof spawn> | undefined;
  try {
    const db = getReceiptDb(dir);
    db.sqlite.exec("PRAGMA busy_timeout = 1;");
    const insert = db.sqlite.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
    const migrationName = `lock_test_${Date.now()}`;

    lockHolder = await holdWriterLock(db.path);
    withSqliteLockRetry(() => {
      insert.run(migrationName, Date.now());
    });

    const row = db.sqlite.query("SELECT name FROM schema_migrations WHERE name = ?").get(migrationName) as
      | { readonly name: string }
      | undefined;
    expect(row?.name).toBe(migrationName);

    const [code] = await once(lockHolder, "exit");
    expect(code).toBe(0);
  } finally {
    if (lockHolder?.exitCode === null) {
      lockHolder.kill("SIGKILL");
      await once(lockHolder, "exit").catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("db client: drizzle writes survive a transient writer lock", async () => {
  const dir = await mkTmp("receipt-db-drizzle-lock");
  let lockHolder: ReturnType<typeof spawn> | undefined;
  try {
    const db = getReceiptDb(dir);
    db.sqlite.exec("PRAGMA busy_timeout = 1;");

    lockHolder = await holdWriterLock(db.path);
    setProjectionOffset(db, "lock_projection", 42);

    expect(getProjectionOffset(db, "lock_projection")).toBe(42);

    const [code] = await once(lockHolder, "exit");
    expect(code).toBe(0);
  } finally {
    if (lockHolder?.exitCode === null) {
      lockHolder.kill("SIGKILL");
      await once(lockHolder, "exit").catch(() => undefined);
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
