import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export type TelemetryArtifactFile = {
  readonly path: string;
  readonly checksum: string;
  readonly bytes: number;
};

export type TelemetryEvidenceRecord = {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly files: ReadonlyArray<TelemetryArtifactFile>;
  readonly proof: {
    readonly verified: string;
    readonly how: string;
  };
};

const redactSecrets = (value: string): string =>
  value
    .replace(/\b(sk-[A-Za-z0-9]{8,})\b/g, "[REDACTED]")
    .replace(/\b(xox[pbar]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]");

const sha256File = async (filePath: string): Promise<TelemetryArtifactFile | undefined> => {
  const stat = await fs.stat(filePath).catch(() => undefined);
  if (!stat?.isFile()) return undefined;
  const body = await fs.readFile(filePath);
  return {
    path: filePath,
    checksum: createHash("sha256").update(body).digest("hex"),
    bytes: stat.size,
  };
};

export const buildTelemetryEvidenceRecord = async (input: {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly filePaths: ReadonlyArray<string>;
  readonly proof: TelemetryEvidenceRecord["proof"];
}): Promise<TelemetryEvidenceRecord> => {
  const files = await Promise.all([...new Set(input.filePaths)].map(async (filePath) => sha256File(filePath)));
  return {
    command: input.command,
    stdout: redactSecrets(input.stdout),
    stderr: redactSecrets(input.stderr),
    exitCode: input.exitCode,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    files: files.filter((item): item is TelemetryArtifactFile => Boolean(item)),
    proof: input.proof,
  };
};

export const writeTelemetryEvidenceRecord = async (input: {
  readonly path: string;
  readonly record: TelemetryEvidenceRecord;
}): Promise<void> => {
  await fs.mkdir(path.dirname(input.path), { recursive: true });
  await fs.writeFile(input.path, `${JSON.stringify(input.record, null, 2)}\n`, "utf-8");
};
