import { sqliteReceiptStore } from "../adapters/sqlite";

export type ReceiptCommandInput =
  | {
      readonly action: "inspect";
      readonly target: string;
    }
  | {
      readonly action: "trace";
      readonly target: string;
    }
  | {
      readonly action: "replay";
      readonly target: string;
    };

export type ReceiptCommandResult =
  | {
      readonly action: "inspect";
      readonly stream: string;
      readonly count: number;
      readonly head: Record<string, unknown> | null;
    }
  | {
      readonly action: "trace";
      readonly stream: string;
      readonly entries: ReadonlyArray<{
        readonly index: number;
        readonly ts: number;
        readonly type: string;
      }>;
    }
  | {
      readonly action: "replay";
      readonly stream: string;
      readonly receipts: ReadonlyArray<Record<string, unknown>>;
    };

const receiptStore = (dataDir: string) =>
  sqliteReceiptStore<Record<string, unknown>>(dataDir);

export const resolveReceiptStream = async (dataDir: string, runOrStream: string): Promise<string> => {
  if (runOrStream.includes("/")) return runOrStream;
  const streams = await receiptStore(dataDir).listStreams?.();
  const direct = streams?.find((stream) => stream === runOrStream);
  if (direct) return direct;
  const suffix = `/runs/${runOrStream}`;
  const runStream = streams?.find((stream) => stream.endsWith(suffix));
  if (runStream) return runStream;
  throw new Error(`Unable to resolve run/stream '${runOrStream}'`);
};

export const readReceiptChain = async (
  dataDir: string,
  stream: string,
): Promise<ReadonlyArray<{ readonly ts: number; readonly body: Record<string, unknown> }>> => {
  const chain = await receiptStore(dataDir).read(stream);
  return chain.map((receipt) => ({ ts: receipt.ts, body: receipt.body }));
};

const inspectReceiptStream = async (dataDir: string, target: string): Promise<ReceiptCommandResult> => {
  const stream = await resolveReceiptStream(dataDir, target);
  const chain = await readReceiptChain(dataDir, stream);
  return {
    action: "inspect",
    stream,
    count: chain.length,
    head: chain[chain.length - 1]?.body ?? null,
  };
};

const traceReceiptStream = async (dataDir: string, target: string): Promise<ReceiptCommandResult> => {
  const stream = await resolveReceiptStream(dataDir, target);
  const chain = await readReceiptChain(dataDir, stream);
  return {
    action: "trace",
    stream,
    entries: chain.map((receipt, index) => ({
      index,
      ts: receipt.ts,
      type: typeof receipt.body.type === "string" ? receipt.body.type : "unknown",
    })),
  };
};

const replayReceiptStream = async (dataDir: string, target: string): Promise<ReceiptCommandResult> => {
  const stream = await resolveReceiptStream(dataDir, target);
  const chain = await readReceiptChain(dataDir, stream);
  return {
    action: "replay",
    stream,
    receipts: chain.map((receipt) => receipt.body),
  };
};

export const executeReceiptCommand = async (
  dataDir: string,
  input: ReceiptCommandInput,
): Promise<ReceiptCommandResult> => {
  switch (input.action) {
    case "inspect":
      return inspectReceiptStream(dataDir, input.target);
    case "trace":
      return traceReceiptStream(dataDir, input.target);
    case "replay":
      return replayReceiptStream(dataDir, input.target);
  }
};
