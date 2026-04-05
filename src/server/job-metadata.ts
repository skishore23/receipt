export const objectiveIdForJob = (
  job: { readonly payload: Record<string, unknown>; readonly result?: unknown } | undefined,
): string | undefined => {
  if (!job) return undefined;
  const payloadObjectiveId = typeof job.payload.objectiveId === "string" && job.payload.objectiveId.trim()
    ? job.payload.objectiveId.trim()
    : undefined;
  if (payloadObjectiveId) return payloadObjectiveId;
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, unknown>
    : undefined;
  return typeof result?.objectiveId === "string" && result.objectiveId.trim()
    ? result.objectiveId.trim()
    : undefined;
};

export const profileIdForJob = (
  job: { readonly payload: Record<string, unknown>; readonly result?: unknown } | undefined,
): string | undefined => {
  if (!job) return undefined;
  const payloadProfile = job.payload.profile;
  if (payloadProfile && typeof payloadProfile === "object" && !Array.isArray(payloadProfile)) {
    const rootProfileId = typeof (payloadProfile as { readonly rootProfileId?: unknown }).rootProfileId === "string"
      ? (payloadProfile as { readonly rootProfileId: string }).rootProfileId.trim()
      : "";
    if (rootProfileId) return rootProfileId;
  }
  const payloadProfileId = typeof job.payload.profileId === "string" && job.payload.profileId.trim()
    ? job.payload.profileId.trim()
    : undefined;
  if (payloadProfileId) return payloadProfileId;
  const result = job.result && typeof job.result === "object" && !Array.isArray(job.result)
    ? job.result as Record<string, unknown>
    : undefined;
  if (result?.profile && typeof result.profile === "object" && !Array.isArray(result.profile)) {
    const rootProfileId = typeof (result.profile as { readonly rootProfileId?: unknown }).rootProfileId === "string"
      ? (result.profile as { readonly rootProfileId: string }).rootProfileId.trim()
      : "";
    if (rootProfileId) return rootProfileId;
  }
  return typeof result?.profileId === "string" && result.profileId.trim()
    ? result.profileId.trim()
    : undefined;
};

export const shouldPublishProfileBoardForJobChange = (
  job: { readonly payload: Record<string, unknown>; readonly result?: unknown } | undefined,
): boolean => {
  if (!profileIdForJob(job)) return false;
  return !objectiveIdForJob(job);
};

export const agentStreamForJob = (
  job: { readonly payload: Record<string, unknown> } | undefined,
): string | undefined => {
  if (!job) return undefined;
  const payloadKind = typeof job.payload.kind === "string" ? job.payload.kind.trim() : "";
  const payloadStream = typeof job.payload.stream === "string" && job.payload.stream.trim()
    ? job.payload.stream.trim()
    : undefined;
  if (payloadKind !== "factory.run") return undefined;
  return payloadStream;
};
