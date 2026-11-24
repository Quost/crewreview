import { SEVERITIES, type Finding, type Severity } from "./model.ts";

/** Why a finding the review produced isn't posted as its own comment. */
export type LeftOutReason = "already-raised" | "over-nit-cap" | "no-evidence" | "unread" | "verifier";

/** One line of the summary: how many findings were left out for one reason. */
export interface LeftOut {
  reason: LeftOutReason;
  count: number;
  /** How many of each severity, most severe first; only severities that occur. Absent when unknown. */
  severities?: { severity: Severity; count: number }[];
  /** For over-nit-cap: how many nits may go inline. */
  cap?: number;
}

export interface PostPlanInput {
  /** Fresh findings: not covered by the discussion. */
  findings: readonly Finding[];
  /** Findings the discussion already raised; they still count in the verdict. */
  repeated: readonly Finding[];
  /** At most this many nits get their own comment. */
  maxNits: number;
  /** Findings the verifier dropped after checking the code. */
  verifierDropped: number;
  /** Findings dropped for citing a file or line that doesn't exist. */
  droppedByEvidence: number;
  /** Findings on files their own lens said it couldn't read. */
  droppedUnread: number;
}

export interface PostPlan {
  /** Commented on their line, or listed as outside the diff. */
  posted: Finding[];
  /** Low confidence: asked as questions in the summary, not stated on a line. */
  unconfirmed: Finding[];
  /** Nits past the cap: listed once in the summary. */
  extraNits: Finding[];
  /** Raised before and still serious enough to name again (blocker and major), as one line each. */
  stillOpen: Finding[];
  /** What the post doesn't comment on, one entry per reason, in a fixed order. Empty reasons are left out. */
  leftOut: LeftOut[];
}

function bySeverity(list: readonly Finding[]): { severity: Severity; count: number }[] {
  return SEVERITIES.map((severity) => ({ severity, count: list.filter((f) => f.severity === severity).length })).filter((s) => s.count > 0);
}

/**
 * Decide what a review posts and count what it leaves out, so a re-review says what it didn't repeat instead of
 * looking like it found less. Nothing is decided by the model here: the cap, the confidence and the discussion do.
 */
export function planPost(i: PostPlanInput): PostPlan {
  const cap = Math.max(0, i.maxNits);
  // Past the cap, nits are listed once in the summary instead of each getting a comment: they're the noise.
  const extraNits = i.findings.filter((f) => f.severity === "nit").slice(cap);
  const extra = new Set(extraNits);
  // A finding its own lens couldn't confirm is a question for the author, not a comment on a line stated as fact.
  const unconfirmed = i.findings.filter((f) => f.confidence === "low" && !extra.has(f));
  const asked = new Set(unconfirmed);
  const posted = i.findings.filter((f) => !extra.has(f) && !asked.has(f));
  const stillOpen = i.repeated.filter((f) => f.severity === "blocker" || f.severity === "major");

  const leftOut: LeftOut[] = [];
  if (i.repeated.length) leftOut.push({ reason: "already-raised", count: i.repeated.length, severities: bySeverity(i.repeated) });
  if (extraNits.length) leftOut.push({ reason: "over-nit-cap", count: extraNits.length, cap });
  if (i.droppedByEvidence > 0) leftOut.push({ reason: "no-evidence", count: i.droppedByEvidence });
  if (i.droppedUnread > 0) leftOut.push({ reason: "unread", count: i.droppedUnread });
  if (i.verifierDropped > 0) leftOut.push({ reason: "verifier", count: i.verifierDropped });
  return { posted, unconfirmed, extraNits, stillOpen, leftOut };
}
