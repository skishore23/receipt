import { fold } from "@receipt/core/chain";
import type { Receipt } from "@receipt/core/types";

import { sqliteReceiptStore } from "../../adapters/sqlite";
import type { FactoryEvent, FactoryProjection, FactoryState } from "../../modules/factory";
import { buildFactoryProjection, initialFactoryState, reduceFactory } from "../../modules/factory";

export type FactoryObjectiveReplayTarget = {
  readonly objectiveId: string;
  readonly stream: string;
};

export type FactoryObjectiveReplaySnapshot = FactoryObjectiveReplayTarget & {
  readonly chain: ReadonlyArray<Receipt<FactoryEvent>>;
  readonly state: FactoryState;
  readonly projection: FactoryProjection;
};

export const objectiveReplayStream = (objectiveIdOrStream: string): FactoryObjectiveReplayTarget => {
  const raw = objectiveIdOrStream.trim();
  const stream = raw.startsWith("factory/objectives/") ? raw : `factory/objectives/${raw}`;
  const objectiveId = stream.replace(/^factory\/objectives\//, "");
  return { objectiveId, stream };
};

export const filterReceiptsAsOf = <T>(
  receipts: ReadonlyArray<Receipt<T>>,
  asOfTs?: number,
): ReadonlyArray<Receipt<T>> => {
  if (typeof asOfTs !== "number" || !Number.isFinite(asOfTs)) return receipts;
  return receipts.filter((receipt) => receipt.ts <= asOfTs);
};

export const readObjectiveReplaySnapshot = async (
  dataDir: string,
  objectiveIdOrStream: string,
  options: {
    readonly asOfTs?: number;
  } = {},
): Promise<FactoryObjectiveReplaySnapshot> => {
  const { objectiveId, stream } = objectiveReplayStream(objectiveIdOrStream);
  const chain = filterReceiptsAsOf(
    await sqliteReceiptStore<FactoryEvent>(dataDir).read(stream),
    options.asOfTs,
  );
  if (chain.length === 0) {
    throw new Error(`No receipts found for ${stream}`);
  }

  const state = fold(chain, reduceFactory, initialFactoryState);
  const projection = buildFactoryProjection(state);
  return {
    objectiveId,
    stream,
    chain,
    state,
    projection,
  };
};
