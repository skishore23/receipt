import type { AgentRunInput, AgentRunResult } from "./agent";
import type { SqliteQueue } from "../adapters/sqlite-queue";
import type { FactoryService } from "../services/factory-service";
import type { ZodTypeAny, infer as ZodInfer } from "zod";
import {
  runFactoryChat,
  normalizeFactoryChatConfig,
  runFactoryCodexJob,
  type FactoryChatRunInput,
  type FactoryChatRunConfig,
  FACTORY_CHAT_DEFAULT_CONFIG,
} from "./factory-chat";
import {
  runCodexSupervisor,
  type CodexSupervisorRunInput,
} from "./codex-supervisor";

export {
  runFactoryCodexJob,
  normalizeFactoryChatConfig,
  type FactoryChatRunConfig,
  FACTORY_CHAT_DEFAULT_CONFIG,
};

export type OrchestratorRunInput = AgentRunInput & {
  readonly queue: SqliteQueue;
  readonly dataDir?: string;
  readonly factoryService?: FactoryService;
  readonly repoRoot?: string;
  readonly profileRoot?: string;
  readonly objectiveId?: string;
  readonly profileId?: string;
  readonly continuationDepth?: number;
  readonly supervisorSessionId?: string;
  readonly llmStructured?: <Schema extends ZodTypeAny>(opts: {
    readonly system?: string;
    readonly user: string;
    readonly schema: Schema;
    readonly schemaName: string;
  }) => Promise<{ readonly parsed: ZodInfer<Schema>; readonly raw: string }>;
};

export const runOrchestrator = async (input: OrchestratorRunInput): Promise<AgentRunResult> => {
  const hasFactoryMode = Boolean(input.factoryService) && Boolean(input.repoRoot) && Boolean(input.llmStructured);

  if (hasFactoryMode) {
    return runFactoryChat({
      ...input,
      config: input.config as FactoryChatRunConfig,
      factoryService: input.factoryService!,
      repoRoot: input.repoRoot!,
      llmStructured: input.llmStructured!,
    } as FactoryChatRunInput);
  }

  return runCodexSupervisor({
    ...input,
    supervisorSessionId: input.supervisorSessionId,
  } as CodexSupervisorRunInput);
};
