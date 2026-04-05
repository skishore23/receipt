export type AwsCostSummaryMode = "online" | "offline";

export type AwsCostSummaryReason =
  | "missing_credentials"
  | "partial_credentials"
  | "empty_credentials"
  | "malformed_credentials"
  | "expired_session_token"
  | "invalid_access_key_id"
  | "missing_region"
  | "invalid_region"
  | "expired_token_error"
  | "invalid_client_token_id"
  | "unrecognized_client_exception"
  | "access_denied"
  | "dns_failure"
  | "timeout"
  | "transient_network";

export type AwsCostSummaryModeDecision = {
  readonly mode: AwsCostSummaryMode;
  readonly reason: AwsCostSummaryReason;
};

export type AwsCostSummaryCredentials =
  | { readonly kind: "none" }
  | { readonly kind: "partial" }
  | { readonly kind: "empty" }
  | { readonly kind: "malformed" }
  | { readonly kind: "expired-session-token" }
  | { readonly kind: "invalid-access-key-id" };

export type AwsCostSummaryConfig =
  | { readonly kind: "missing-region" }
  | { readonly kind: "invalid-region" };

export type AwsCostSummaryError =
  | { readonly code: "ExpiredToken" }
  | { readonly code: "InvalidClientTokenId" }
  | { readonly code: "UnrecognizedClientException" }
  | { readonly code: "AccessDenied" }
  | { readonly code: "ENOTFOUND" }
  | { readonly code: "ETIMEDOUT" };

export type AwsCostSummaryDecisionInput = {
  readonly mode: "auto" | "online" | "offline";
  readonly credentials?: AwsCostSummaryCredentials;
  readonly config?: AwsCostSummaryConfig;
  readonly error?: AwsCostSummaryError;
};

const offline = (reason: AwsCostSummaryReason): AwsCostSummaryModeDecision => ({
  mode: "offline",
  reason,
});

export const decideMode = (input: AwsCostSummaryDecisionInput): AwsCostSummaryModeDecision => {
  if (input.mode === "offline") return offline("transient_network");
  if (input.credentials) {
    switch (input.credentials.kind) {
      case "none":
        return offline("missing_credentials");
      case "partial":
        return offline("partial_credentials");
      case "empty":
        return offline("empty_credentials");
      case "malformed":
        return offline("malformed_credentials");
      case "expired-session-token":
        return offline("expired_session_token");
      case "invalid-access-key-id":
        return offline("invalid_access_key_id");
    }
  }
  if (input.config) {
    switch (input.config.kind) {
      case "missing-region":
        return offline("missing_region");
      case "invalid-region":
        return offline("invalid_region");
    }
  }
  if (input.mode === "auto" && input.error) {
    switch (input.error.code) {
      case "ExpiredToken":
        return offline("expired_token_error");
      case "InvalidClientTokenId":
        return offline("invalid_client_token_id");
      case "UnrecognizedClientException":
        return offline("unrecognized_client_exception");
      case "AccessDenied":
        return offline("access_denied");
      case "ENOTFOUND":
        return offline("dns_failure");
      case "ETIMEDOUT":
        return offline("timeout");
    }
  }
  return { mode: "online", reason: "transient_network" };
};
