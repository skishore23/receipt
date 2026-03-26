export type ActionKind = "action" | "assistant" | "tool" | "human";
export type ActionExecutionMode = "local" | "remote";

export type ActionRunContext<View, EmitFn> = {
  readonly view: View;
  readonly emit: EmitFn;
};

export type AgentAction<View, EmitFn = (type: string, body: Record<string, unknown>) => void> = {
  readonly id: string;
  readonly kind: ActionKind;
  readonly when?: (ctx: { readonly view: View }) => boolean;
  readonly run: (ctx: ActionRunContext<View, EmitFn>) => Promise<void> | void;
  readonly watch?: ReadonlyArray<string>;
  readonly exclusive?: boolean;
  readonly maxConcurrency?: number;
  readonly execution?: ActionExecutionMode;
  readonly targetGroup?: string;
};

const mkAction = <View, EmitFn>(kind: ActionKind, id: string, spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">): AgentAction<View, EmitFn> => ({
  id,
  kind,
  ...spec,
});

export const action = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("action", id, spec);

export const assistant = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("assistant", id, spec);

export const tool = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("tool", id, spec);

export const human = <View, EmitFn = (type: string, body: Record<string, unknown>) => void>(
  id: string,
  spec: Omit<AgentAction<View, EmitFn>, "id" | "kind">
): AgentAction<View, EmitFn> => mkAction("human", id, spec);
