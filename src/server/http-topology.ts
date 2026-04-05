import type { ReceiptProcessRole } from "../adapters/resonate-config";

export type ServerJobBackend = "local" | "resonate";

export const deriveServerRuntimeFlags = (
  jobBackend: ServerJobBackend,
  processRole: ReceiptProcessRole,
): {
  readonly shouldServeHttp: boolean;
  readonly shouldRunHeartbeats: boolean;
} => {
  const apiVisible = jobBackend === "local" || processRole === "api";
  return {
    shouldServeHttp: apiVisible,
    shouldRunHeartbeats: apiVisible,
  };
};
