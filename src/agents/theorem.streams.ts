// ============================================================================
// Theorem Guild stream naming helpers
//
// Runs live in their own stream for clean receipts; the base stream is the index.
// ============================================================================

export const theoremRunStream = (base: string, runId: string): string =>
  `${base}/runs/${runId}`;

export const theoremBranchStream = (runStream: string, branchId: string): string =>
  `${runStream}/branches/${branchId}`;
