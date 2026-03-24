export type GraphRefKind =
  | "state"
  | "artifact"
  | "file"
  | "workspace"
  | "commit"
  | "job"
  | "prompt";

export type GraphRef = {
  readonly kind: GraphRefKind;
  readonly ref: string;
  readonly label?: string;
};
