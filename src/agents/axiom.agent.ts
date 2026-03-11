import type { Runtime } from "../core/runtime.js";
import type { AgentLoaderContext, AgentModuleFactory, AgentRouteModule } from "../framework/agent-types.js";
import type { TheoremCmd, TheoremEvent, TheoremState } from "../modules/theorem.js";
import { runTheoremGuild } from "./theorem.js";
import { createTheoremRoute } from "./theorem.agent.js";

const AXIOM_GUILD_EXAMPLES = [
  {
    id: "starter",
    label: "Starter proof",
    problem: "Prove theorem foo : 1 = 1. Keep the normal theorem guild search and let verifier or explorers delegate Lean validation to Axiom when useful.",
  },
  {
    id: "append-length",
    label: "List append",
    problem: "In Lean 4 with Mathlib, prove theorem list_length_append_nat (xs ys : List Nat) : List.length (xs ++ ys) = List.length xs + List.length ys. Use Axiom workers for real Lean checking or repair when needed.",
  },
  {
    id: "repair",
    label: "Repair path",
    problem: "Start with a flawed Lean proof of Nat.add_comm for a constrained case, branch aggressively, and use Axiom workers to repair or reject weak proof attempts before synthesis.",
  },
  {
    id: "reject-false",
    label: "Reject false theorem",
    problem: "Investigate theorem bad : 2 = 3. Use the normal theorem guild debate, but require an Axiom worker to explain the verification failure or disproval path.",
  },
] as const;

const factory: AgentModuleFactory = (ctx: AgentLoaderContext): AgentRouteModule =>
  createTheoremRoute({
    runtime: ctx.runtimes.theorem as Runtime<TheoremCmd, TheoremEvent, TheoremState>,
    llmText: ctx.llmText,
    prompts: ctx.prompts.theorem as Parameters<typeof runTheoremGuild>[0]["prompts"],
    promptHash: ctx.promptHashes.theorem ?? "",
    promptPath: ctx.promptPaths.theorem ?? "prompts/theorem.prompts.json",
    model: ctx.models.theorem ?? "gpt-5.2",
    sse: ctx.sse,
    enqueueJob: ctx.enqueueJob,
  }, {
    routeId: "axiom",
    basePath: "/axiom",
    defaultStream: "agents/axiom-guild",
    jobAgentId: "axiom-guild",
    jobKind: "axiom-guild.run",
    jobIdPrefix: "axiom_guild",
    title: "Receipt - Axiom Guild",
    brand: "Axiom Guild",
    brandTag: "AXLE",
    brandSub: "Theorem guild orchestration outside. AXLE-powered Lean workers inside.",
    controlsTitle: "AXLE Multi-Agent Proof Run",
    controlsSub: "Theorem-style branching, critique, merge, and rebracketing with optional Axiom delegation for real Lean verification and repair.",
    runButtonLabel: "Run Axiom Guild",
    examples: AXIOM_GUILD_EXAMPLES,
  });

export default factory;
