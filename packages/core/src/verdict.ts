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

/**
 * Changed files no lens read: some lens listed them as not reviewed, and none that ran to the end read them. A lens
 * keeps to its own concern (architecture may skip a stylesheet), so a file another lens read was reviewed.
 */
export function unreviewedFiles(lenses: readonly LensResult[]): string[] {
  const listed = [...new Set(lenses.flatMap((l) => l.uncovered))];
  return listed.filter((f) => !lenses.some((l) => l.status === "ok" && !l.uncovered.includes(f)));
}

/** A lens that didn't finish, or a changed file no lens read: the review isn't whole. */
function incomplete(lenses: readonly LensResult[]): boolean {
  if (lenses.some((l) => l.status === "failed" || l.status === "hallucinated")) return true;
  // Partial without saying which files: nobody knows what it skipped.
  if (lenses.some((l) => l.coverage === "partial" && l.uncovered.length === 0)) return true;
  return unreviewedFiles(lenses).length > 0;
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
  if (incomplete(input.lenses)) reasons.push("lens-failed");
  if (input.partial) reasons.push("partial-review");
  if (!(input.ci === "green" || input.ci === "none")) reasons.push("ci-not-green");
  if (input.changedLines > policy.approveMaxChangedLines) reasons.push("diff-too-large");
  if (!input.verifierRan) reasons.push("verifier-missing");

  if (reasons.length === 0) return { event: "approve", reasons: ["clean"], counts };
  return { event: "comment", reasons, counts };
}
