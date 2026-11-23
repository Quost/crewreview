import type { CiState, Finding, LensResult } from "./model.ts";
import { unreviewedFiles } from "./verdict.ts";

/**
 * How far a review can be trusted, decided by code from what happened, never by the model:
 * - trusted: every lens finished, every changed file was read, the verifier ran, CI is green or absent, and nothing
 *   blocker or major is open. Someone can merge on it.
 * - partial: the review is honest but not whole, or found something to fix first. Read what it says it didn't cover.
 * - untrusted: a blocker is open, CI is red, or the change is too large for a review to stand for it.
 */
export type TrustLevel = "trusted" | "partial" | "untrusted";

export type TrustReason =
  | "blocker-open"
  | "ci-red"
  | "too-large"
  | "major-open"
  | "lens-failed"
  | "files-unread"
  | "verifier-missing"
  | "some-lenses"
  | "ci-pending";

export interface TrustInput {
  /** Every finding still in the code, the ones already discussed included. */
  findings: readonly Pick<Finding, "severity">[];
  lenses: readonly LensResult[];
  ci: CiState;
  changedLines: number;
  /** Above this, no review stands for the change. */
  maxChangedLines: number;
  verifierRan: boolean;
  /** Only some lenses were asked for. */
  partial: boolean;
}

export interface Trust {
  level: TrustLevel;
  reasons: TrustReason[];
}

export function trustLevel(i: TrustInput): Trust {
  const untrusted: TrustReason[] = [];
  if (i.findings.some((f) => f.severity === "blocker")) untrusted.push("blocker-open");
  if (i.ci === "red") untrusted.push("ci-red");
  if (i.changedLines > i.maxChangedLines) untrusted.push("too-large");
  if (untrusted.length) return { level: "untrusted", reasons: untrusted };

  const partial: TrustReason[] = [];
  if (i.findings.some((f) => f.severity === "major")) partial.push("major-open");
  if (i.lenses.some((l) => l.status === "failed" || l.status === "hallucinated" || (l.coverage === "partial" && l.uncovered.length === 0))) partial.push("lens-failed");
  if (unreviewedFiles(i.lenses).length) partial.push("files-unread");
  if (!i.verifierRan) partial.push("verifier-missing");
  if (i.partial) partial.push("some-lenses");
  if (i.ci === "running" || i.ci === "unknown") partial.push("ci-pending");
  return partial.length ? { level: "partial", reasons: partial } : { level: "trusted", reasons: [] };
}
