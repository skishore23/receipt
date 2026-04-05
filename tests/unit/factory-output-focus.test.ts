import { test, expect } from "bun:test";
import { resolveFactoryOutputFocus } from "../../src/agents/factory/output-focus";

test("factory.output focus resolution rejects ambiguous multi-task objectives", async () => {
  const detail = {
    objectiveId: "objective_demo",
    tasks: [
      { taskId: "task_01" },
      { taskId: "task_02" },
    ],
  } as any;
  const service = {
    getObjective: async () => detail,
    inferObjectiveLiveOutputFocus: async () => undefined,
  };

  await expect(resolveFactoryOutputFocus({
    factoryService: service,
    objectiveId: "objective_demo",
  })).rejects.toThrow(/Available taskIds: task_01, task_02/);
});

test("factory.output focus resolution uses FACTORY_TASK_ID when present", async () => {
  const service = {
    getObjective: async () => {
      throw new Error("should not load objective when env task id is provided");
    },
    inferObjectiveLiveOutputFocus: async () => undefined,
  };

  await expect(resolveFactoryOutputFocus({
    factoryService: service,
    objectiveId: "objective_demo",
    env: {
      FACTORY_TASK_ID: "task_02",
    } as NodeJS.ProcessEnv,
  })).resolves.toEqual({ focusKind: "task", focusId: "task_02" });
});
