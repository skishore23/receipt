import type { Hono } from "hono";

export type AgentKind = "todo" | "run" | "inspector";

export type AgentManifestBase = {
  readonly id: string;
  readonly kind: AgentKind;
  readonly paths: Readonly<Record<string, string>>;
  readonly register: (app: Hono) => void;
};

export type TodoAgentManifest = AgentManifestBase & {
  readonly kind: "todo";
};

export type RunAgentManifest = AgentManifestBase & {
  readonly kind: "run";
};

export type InspectorAgentManifest = AgentManifestBase & {
  readonly kind: "inspector";
};

export type AgentManifest =
  | TodoAgentManifest
  | RunAgentManifest
  | InspectorAgentManifest;
