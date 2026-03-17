import { test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverFactoryChatProfiles,
  factoryChatStream,
  factoryObjectiveStream,
  factoryProfileStream,
  repoKeyForRoot,
  resolveFactoryChatProfile,
} from "../../src/services/factory-chat-profiles.ts";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const writeProfile = async (root: string, input: {
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly default?: boolean;
  readonly imports?: ReadonlyArray<string>;
  readonly routeHints?: ReadonlyArray<string>;
  readonly toolAllowlist?: ReadonlyArray<string>;
  readonly orchestration?: {
    readonly executionMode?: "interactive" | "supervisor";
    readonly discoveryBudget?: number;
    readonly suspendOnAsyncChild?: boolean;
    readonly allowPollingWhileChildRunning?: boolean;
    readonly finalWhileChildRunning?: "allow" | "waiting_message" | "reject";
    readonly childDedupe?: "none" | "by_run_and_prompt";
  };
}): Promise<void> => {
  const dir = path.join(root, "profiles", input.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "PROFILE.md"), `# ${input.label}\n\nProfile instructions for ${input.id}.\n`, "utf-8");
  await fs.writeFile(path.join(dir, "profile.json"), JSON.stringify({
    id: input.id,
    label: input.label,
    enabled: input.enabled ?? true,
    default: input.default ?? false,
    imports: input.imports ?? [],
    routeHints: input.routeHints ?? [],
    toolAllowlist: input.toolAllowlist ?? [],
    orchestration: input.orchestration ?? {},
    handoffTargets: [],
  }, null, 2), "utf-8");
};

test("factory chat profiles: discovers enabled profiles and ignores disabled ones", async () => {
  const root = await createTempDir("receipt-factory-profiles");
  await writeProfile(root, { id: "generalist", label: "Generalist", default: true });
  await writeProfile(root, { id: "disabled", label: "Disabled", enabled: false });

  const profiles = await discoverFactoryChatProfiles(root);
  expect(profiles.map((profile) => profile.id)).toEqual(["generalist"]);
});

test("factory chat profiles: resolves imports, route hints, and profile hashes separately from repo root", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "shared",
    label: "Shared",
    toolAllowlist: ["memory.read", "factory.status"],
    orchestration: {
      executionMode: "supervisor",
      childDedupe: "by_run_and_prompt",
    },
  });
  await writeProfile(profileRoot, {
    id: "reviewer",
    label: "Reviewer",
    imports: ["shared"],
    routeHints: ["review", "critique"],
    toolAllowlist: ["profile.handoff"],
    orchestration: {
      discoveryBudget: 1,
      finalWhileChildRunning: "reject",
    },
  });
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    routeHints: ["ship", "debug"],
    toolAllowlist: ["codex.run"],
  });

  const resolved = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    problem: "Please review this patch critically.",
  });

  expect(resolved.root.id).toBe("reviewer");
  expect(resolved.imports.map((profile) => profile.id)).toEqual(["shared"]);
  expect(resolved.toolAllowlist).toEqual(["memory.read", "factory.status", "profile.handoff"]);
  expect(resolved.orchestration.executionMode).toBe("supervisor");
  expect(resolved.orchestration.discoveryBudget).toBe(1);
  expect(resolved.orchestration.suspendOnAsyncChild).toBe(true);
  expect(resolved.orchestration.allowPollingWhileChildRunning).toBe(false);
  expect(resolved.orchestration.finalWhileChildRunning).toBe("reject");
  expect(resolved.orchestration.childDedupe).toBe("by_run_and_prompt");
  expect(resolved.promptPath).toBe("profiles/reviewer/PROFILE.md");
  expect(resolved.profilePaths).toContain("profiles/shared/PROFILE.md");
  expect(resolved.profileRoot).toBe(path.resolve(profileRoot));
  expect(resolved.repoRoot).toBe(path.resolve(repoRoot));
});

test("factory chat profiles: routes concrete bug-fix prompts to the software profile", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    routeHints: ["factory", "status", "delivery"],
    toolAllowlist: ["jobs.list"],
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    routeHints: ["bug", "fix", "ui", "tailwind", "truncate"],
    toolAllowlist: ["codex.run", "write"],
  });

  const resolved = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    problem: "Fix this UI bug in the factory left rail and truncate long titles.",
  });

  expect(resolved.root.id).toBe("software");
  expect(resolved.selectionReason).toBe("route_hint");
  expect(resolved.toolAllowlist).toEqual(["codex.run", "write"]);
});

test("factory chat profiles: route hints match whole words and phrases instead of loose substrings", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    routeHints: ["status"],
    toolAllowlist: ["jobs.list"],
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    routeHints: ["ui", "failing test"],
    toolAllowlist: ["codex.run"],
  });

  const resolved = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    problem: "Show me the build status.",
  });

  expect(resolved.root.id).toBe("generalist");
  expect(resolved.selectionReason).toBe("route_hint");
});

test("factory chat profiles: allowDefaultOverride lets the default profile yield to software for bug-fix prompts", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
    routeHints: ["status", "planning"],
    toolAllowlist: ["jobs.list"],
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    routeHints: ["bug", "fix", "ui"],
    toolAllowlist: ["codex.run"],
  });

  const resolved = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    requestedId: "generalist",
    problem: "Fix the UI bug in the sidebar.",
    allowDefaultOverride: true,
  });

  expect(resolved.root.id).toBe("software");
  expect(resolved.selectionReason).toBe("route_hint");
});

test("factory chat profiles: repo-scoped stream key depends on the target repo root", async () => {
  const repoRoot = "/tmp/factory-target";
  const stream = factoryProfileStream(repoRoot, "generalist");
  expect(stream).toBe(`agents/factory/${repoKeyForRoot(repoRoot)}/generalist`);
});

test("factory chat profiles: objective stream key nests under the selected profile stream", async () => {
  const repoRoot = "/tmp/factory-target";
  expect(factoryObjectiveStream(repoRoot, "software", "objective_demo")).toBe(
    `agents/factory/${repoKeyForRoot(repoRoot)}/software/objectives/objective_demo`,
  );
  expect(factoryChatStream(repoRoot, "software", "objective_demo")).toBe(
    `agents/factory/${repoKeyForRoot(repoRoot)}/software/objectives/objective_demo`,
  );
  expect(factoryChatStream(repoRoot, "software")).toBe(
    `agents/factory/${repoKeyForRoot(repoRoot)}/software`,
  );
});
