// ============================================================================
// Delegation Tools - framework-level agent-to-agent delegation primitives
// ============================================================================

import { readReceiptFile, buildReceiptContext } from "./receipt-tools.js";

export type DelegationDeps = {
  readonly enqueue: (opts: {
    readonly agentId: string;
    readonly payload: Record<string, unknown>;
  }) => Promise<{ readonly id: string }>;
  readonly waitForJob: (jobId: string, timeoutMs: number) => Promise<JobSnapshot>;
  readonly getJob: (jobId: string) => Promise<JobSnapshot>;
  readonly dataDir: string;
};

export type JobSnapshot = {
  readonly id: string;
  readonly status: string;
  readonly result?: Record<string, unknown>;
  readonly lastError?: string;
};

export type ToolResult = {
  readonly output: string;
  readonly summary: string;
};

export type DelegationToolName = "agent.delegate" | "agent.status" | "agent.inspect";

export type DelegationTools = Readonly<
  Record<DelegationToolName, (input: Record<string, unknown>) => Promise<ToolResult>>
>;

const requireString = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
};

const requireNumber = (input: Record<string, unknown>, key: string, fallback: number): number => {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
};

const truncate = (text: string, limit: number): { readonly text: string; readonly truncated: boolean } => {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit - 3)}...`, truncated: true };
};

export const createDelegationTools = (deps: DelegationDeps): DelegationTools => ({
  "agent.delegate": async (input) => {
    const agentId = requireString(input, "agentId");
    const task = requireString(input, "task");
    const timeoutMs = requireNumber(input, "timeoutMs", 120_000);

    const configInput = input.config;
    if (configInput !== undefined && (typeof configInput !== "object" || !configInput || Array.isArray(configInput))) {
      throw new Error("config must be an object when provided");
    }
    const config = (configInput ?? {}) as Record<string, unknown>;

    const job = await deps.enqueue({
      agentId,
      payload: {
        kind: `${agentId}.run`,
        problem: task,
        config,
        isSubAgent: true,
      },
    });

    const settled = await deps.waitForJob(job.id, timeoutMs);

    const resultText = settled.result
      ? JSON.stringify(settled.result)
      : settled.lastError ?? settled.status;

    const clipped = truncate(resultText, 4_000);
    return {
      output: `job ${job.id} ${settled.status}: ${clipped.text}`,
      summary: `delegated to ${agentId}: ${settled.status}`,
    };
  },

  "agent.status": async (input) => {
    const jobId = requireString(input, "jobId");
    const job = await deps.getJob(jobId);
    const output = JSON.stringify({
      id: job.id,
      status: job.status,
      result: job.result,
      lastError: job.lastError,
    });
    return { output, summary: `job ${jobId}: ${job.status}` };
  },

  "agent.inspect": async (input) => {
    const file = requireString(input, "file");
    const maxChars = requireNumber(input, "maxChars", 4_000);

    const records = await readReceiptFile(deps.dataDir, file);
    if (records.length === 0) {
      return { output: "(empty chain)", summary: `${file}: 0 records` };
    }

    const context = buildReceiptContext(records, maxChars);
    const clipped = truncate(context, maxChars);
    return {
      output: clipped.text,
      summary: `${file}: ${records.length} records${clipped.truncated ? " (truncated)" : ""}`,
    };
  },
});
