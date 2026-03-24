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
} from "../../src/services/factory-chat-profiles";

const createTempDir = async (label: string): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));

const writeProfile = async (root: string, input: {
  readonly id: string;
  readonly label: string;
  readonly default?: boolean;
  readonly skills?: ReadonlyArray<string>;
  readonly cloudProvider?: "aws" | "gcp" | "azure";
  readonly defaultObjectiveMode?: "delivery" | "investigation";
  readonly defaultValidationMode?: "repo_profile" | "none";
  readonly defaultTaskExecutionMode?: "worktree" | "isolated";
  readonly allowObjectiveCreation?: boolean;
  readonly extraManifest?: Record<string, unknown>;
}): Promise<void> => {
  const dir = path.join(root, "profiles", input.id);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    id: input.id,
    label: input.label,
    default: input.default ?? false,
    skills: input.skills ?? [],
    cloudProvider: input.cloudProvider,
    defaultObjectiveMode: input.defaultObjectiveMode,
    defaultValidationMode: input.defaultValidationMode,
    defaultTaskExecutionMode: input.defaultTaskExecutionMode,
    allowObjectiveCreation: input.allowObjectiveCreation,
    ...(input.extraManifest ?? {}),
  };
  await fs.writeFile(
    path.join(dir, "PROFILE.md"),
    `---\n${JSON.stringify(manifest, null, 2)}\n---\n\n# ${input.label}\n\nProfile instructions for ${input.id}.\n`,
    "utf-8",
  );
};

test("factory chat profiles: discovers checked-in profiles under the profile root", async () => {
  const root = await createTempDir("receipt-factory-profiles");
  await writeProfile(root, { id: "generalist", label: "Generalist", default: true });
  await writeProfile(root, { id: "software", label: "Software" });

  const profiles = await discoverFactoryChatProfiles(root);
  expect(profiles.map((profile) => profile.id)).toEqual(["generalist", "software"]);
});

test("factory chat profiles: resolves an explicitly requested profile with the minimal contract", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
  });
  await writeProfile(profileRoot, {
    id: "infrastructure",
    label: "Infrastructure",
    skills: ["skills/factory-infrastructure-aws/SKILL.md"],
    cloudProvider: "aws",
    defaultObjectiveMode: "investigation",
    defaultValidationMode: "none",
    defaultTaskExecutionMode: "isolated",
    allowObjectiveCreation: true,
  });

  const resolved = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    requestedId: "infrastructure",
    problem: "ignored once the profile is explicit",
  });

  expect(resolved.root.id).toBe("infrastructure");
  expect(resolved.selectionReason).toBe("requested");
  expect(resolved.imports).toEqual([]);
  expect(resolved.stack.map((profile) => profile.id)).toEqual(["infrastructure"]);
  expect(resolved.skills).toEqual(["skills/factory-infrastructure-aws/SKILL.md"]);
  expect(resolved.root.cloudProvider).toBe("aws");
  expect(resolved.cloudProvider).toBe("aws");
  expect(resolved.objectivePolicy.defaultObjectiveMode).toBe("investigation");
  expect(resolved.objectivePolicy.defaultValidationMode).toBe("none");
  expect(resolved.objectivePolicy.defaultTaskExecutionMode).toBe("isolated");
  expect(resolved.objectivePolicy.maxParallelChildren).toBe(1);
  expect(resolved.promptPath).toBe("profiles/infrastructure/PROFILE.md");
  expect(resolved.toolAllowlist).toContain("factory.dispatch");
  expect(resolved.toolAllowlist).not.toContain("profile.handoff");
  expect(resolved.systemPrompt).toContain("You are the active Factory profile in the product UI.");
  expect(resolved.systemPrompt).toContain("single task at a time");
});

test("factory chat profiles: falls back to the default profile without route-hint selection", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "generalist",
    label: "Generalist",
    default: true,
  });
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    defaultObjectiveMode: "delivery",
  });

  const resolved = await resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
    problem: "Fix the sidebar bug.",
  });

  expect(resolved.root.id).toBe("generalist");
  expect(resolved.selectionReason).toBe("default");
});

test("factory chat profiles: rejects removed manifest keys", async () => {
  const profileRoot = await createTempDir("receipt-factory-profile-root");
  const repoRoot = await createTempDir("receipt-factory-target-repo");
  await writeProfile(profileRoot, {
    id: "software",
    label: "Software",
    default: true,
    extraManifest: {
      routeHints: ["bug", "fix"],
    },
  });

  await expect(resolveFactoryChatProfile({
    repoRoot,
    profileRoot,
  })).rejects.toThrow("removed factory profile key 'routeHints'");
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
