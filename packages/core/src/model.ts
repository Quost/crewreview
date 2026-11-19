/** Most severe first. The order is the ranking: index 0 is the most severe. */
export const SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** 0 is the most severe. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/** True when `a` is at least as severe as `b`. */
export function atLeast(a: Severity, b: Severity): boolean {
  return severityRank(a) <= severityRank(b);
}

/** True when `a` is strictly less severe than `b`. */
export function lessSevere(a: Severity, b: Severity): boolean {
  return severityRank(a) > severityRank(b);
}

export function mostSevere(list: readonly Severity[]): Severity | undefined {
  let best: Severity | undefined;
  for (const s of list) if (best === undefined || atLeast(s, best)) best = s;
  return best;
}

export type VerifierAction = "confirm" | "downgrade" | "drop" | "duplicate";

export interface Verification {
  action: VerifierAction;
  reason: string;
  /** Severity before a downgrade. */
  from?: Severity;
  /** For a duplicate: the id of the finding it repeats. */
  of?: string;
}

export interface Finding {
  /** Stable within one review: F1, F2… */
  id: string;
  /** The lens that reported it first. */
  lens: string;
  /** Every lens that reported it (after dedupe). */
  lenses: string[];
  /** Repository-relative POSIX path. */
  path: string;
  line: number;
  endLine?: number;
  severity: Severity;
  title: string;
  body: string;
  evidence?: string;
  suggestion?: string;
  confidence: Confidence;
  verification?: Verification;
}

export type LensStatus = "ok" | "failed" | "hallucinated" | "skipped";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface LensResult {
  lens: string;
  harness: string;
  status: LensStatus;
  findings: Finding[];
  coverage: "full" | "partial";
  uncovered: string[];
  durationMs: number;
  error?: string;
  usage?: Usage;
}

/** CI state of the reviewed head. `green-with-warnings`: an allowed-to-fail job failed. */
export type CiState = "green" | "green-with-warnings" | "running" | "red" | "none" | "unknown";

export type VerdictEvent = "approve" | "comment" | "request_changes";
