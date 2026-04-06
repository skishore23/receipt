import { createRuntime } from "@receipt/core/runtime";

import { jsonBranchStore, jsonlStore } from "../adapters/jsonl";
import {
  decideMemory,
  initialMemoryState,
  reduceMemory,
  type MemoryCmd,
  type MemoryEvent,
  type MemoryState,
} from "../adapters/memory-tools";
import type { AgentCmd, AgentEvent, AgentState } from "../modules/agent";
import { decide as decideAgent, initial as initialAgent, reduce as reduceAgent } from "../modules/agent";
import type { JobCmd, JobEvent, JobState } from "../modules/job";
import { decide as decideJob, initial as initialJob, reduce as reduceJob } from "../modules/job";

export const createServerComposition = (dataDir: string) => {
  const branchStore = jsonBranchStore(dataDir);
  const agentStore = jsonlStore<AgentEvent>(dataDir);
  const agentRuntime = createRuntime<AgentCmd, AgentEvent, AgentState>(
    agentStore,
    branchStore,
    decideAgent,
    reduceAgent,
    initialAgent,
  );
  const jobStore = jsonlStore<JobEvent>(dataDir);
  const jobRuntime = createRuntime<JobCmd, JobEvent, JobState>(
    jobStore,
    branchStore,
    decideJob,
    reduceJob,
    initialJob,
  );
  const memoryStore = jsonlStore<MemoryEvent>(dataDir);
  const memoryRuntime = createRuntime<MemoryCmd, MemoryEvent, MemoryState>(
    memoryStore,
    branchStore,
    decideMemory,
    reduceMemory,
    initialMemoryState,
  );
  return {
    branchStore,
    agentStore,
    agentRuntime,
    jobStore,
    jobRuntime,
    memoryStore,
    memoryRuntime,
  };
};
