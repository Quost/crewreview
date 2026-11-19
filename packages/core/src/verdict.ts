import { atLeast, type CiState, type Finding, type LensResult, type Severity, type VerdictEvent } from "./model.ts";

export interface VerdictPolicy {
  /** A verified finding at or above this severity requests changes. */
  requestChangesAt: Severity;
  /** Posting approvals is opt-in: an approval from a person's own account carries weight. */
  allowApprove: boolean;
  /** Any finding at or above this severity blocks an approval. */
  approveBlockedAt: Severity;
  /** Bigger changes never get an automatic approval. */
  approveMaxChangedLines: number;
  /** Blockers found without the verifier only comment. */
  requireVerifier: boolean;
}

export const DEFAULT_POLICY: VerdictPolicy = {
  requestChangesAt: "blocker",
  allowApprove: false,
  approveBlockedAt: "major",
  approveMaxChangedLines: 1500,
  requireVerifier: true,
};

export type VerdictReason =
  | "blocking-findings"
  | "unverified-blockers"
  | "approve-disabled"
  | "findings-block-approval"
  | "lens-failed"
  | "partial-review"
  | "ci-not-green"
  | "diff-too-large"
  | "verifier-missing"
  | "clean";

export interface VerdictInput {
  findings: readonly Finding[];
  lenses: readonly LensResult[];
  ci: CiState;
  changedLines: number;
  verifierRan: boolean;
  /** Only some lenses were asked to run (e.g. `--lens security`). */
  partial: boolean;
}

export interface Verdict {
  event: VerdictEvent;
  reasons: VerdictReason[];
  counts: Record<Severity, number>;
}

/** The model proposes; this decides. Same inputs, same verdict, every time. */
export function decideVerdict(input: VerdictInput, policy: VerdictPolicy = DEFAULT_POLICY): Verdict {
  const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of input.findings) counts[f.severity]++;

  const blocking = input.findings.filter((f) => atLeast(f.severity, policy.requestChangesAt));
  if (blocking.length > 0) {
    if (input.verifierRan || !policy.requireVerifier) return { event: "request_changes", reasons: ["blocking-findings"], counts };
    return { event: "comment", reasons: ["unverified-blockers"], counts };
  }

  const reasons: VerdictReason[] = [];
  if (!policy.allowApprove) reasons.push("approve-disabled");
  if (input.findings.some((f) => atLeast(f.severity, policy.approveBlockedAt))) reasons.push("findings-block-approval");
  if (input.lenses.some((l) => l.status === "failed" || l.status === "hallucinated" || l.coverage === "partial")) {
    reasons.push("lens-failed");
  }
  if (input.partial) reasons.push("partial-review");
  if (!(input.ci === "green" || input.ci === "none")) reasons.push("ci-not-green");
  if (input.changedLines > policy.approveMaxChangedLines) reasons.push("diff-too-large");
  if (!input.verifierRan) reasons.push("verifier-missing");

  if (reasons.length === 0) return { event: "approve", reasons: ["clean"], counts };
  return { event: "comment", reasons, counts };
}
