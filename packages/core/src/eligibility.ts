import type { CiState } from "./model.ts";

/** What a git host tells us about a pull request (GitHub) or merge request (GitLab). */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  author: string;
  authorIsBot: boolean;
  draft: boolean;
  state: "open" | "closed" | "merged";
  headSha: string;
  headRef: string;
  baseRef: string;
  baseSha?: string;
  labels: string[];
  updatedAt: string;
  url: string;
  fromFork: boolean;
  /** GitLab needs these to place inline comments. */
  diffRefs?: { baseSha: string; startSha: string; headSha: string };
}

export type AuthorFilter = "others" | "all" | "mine";

export interface ReviewRules {
  /** Whose pull requests to review. Reviewing your own is a self-check before asking people. */
  authors: AuthorFilter;
  /** A label that keeps the crew away. */
  skipLabels: string[];
  /** Only pull requests into these branches (empty: any). */
  baseBranches: string[];
  /** Wait this long after a new head appears, so a series of pushes lands first. */
  settleMs: number;
  /** Don't review while CI runs, up to this long after the head appeared. 0 never waits. */
  ciMaxWaitMs: number;
  /** Give up on a head after this many failed runs. */
  maxFailures: number;
  reviewDrafts: boolean;
  reviewBots: boolean;
}

export const DEFAULT_RULES: ReviewRules = {
  authors: "others",
  skipLabels: ["no-ai-review"],
  baseBranches: [],
  settleMs: 3 * 60_000,
  ciMaxWaitMs: 45 * 60_000,
  maxFailures: 2,
  reviewDrafts: false,
  reviewBots: false,
};

export type SkipReason =
  | "closed"
  | "draft"
  | "bot-author"
  | "own"
  | "not-own"
  | "label"
  | "base-branch"
  | "already-reviewed"
  | "too-many-failures"
  | "settling"
  | "ci-running";

export interface EligibilityInput {
  pr: PullRequest;
  me: string;
  rules: ReviewRules;
  /** Head we last reviewed (from our state or from our own marker on the host). */
  reviewedSha?: string;
  failuresOnHead: number;
  /** When we first saw this head. */
  firstSeenAt: number;
  now: number;
  ci: CiState | undefined;
}

export type Eligibility = { eligible: true } | { eligible: false; reason: SkipReason };

const no = (reason: SkipReason): Eligibility => ({ eligible: false, reason });

/** Should the crew review this pull request now? Pure: same input, same answer. */
export function reviewEligibility(i: EligibilityInput): Eligibility {
  const { pr, rules } = i;
  if (pr.state !== "open") return no("closed");
  if (pr.draft && !rules.reviewDrafts) return no("draft");
  if (pr.authorIsBot && !rules.reviewBots) return no("bot-author");
  const mine = pr.author.toLowerCase() === i.me.toLowerCase();
  if (rules.authors === "others" && mine) return no("own");
  if (rules.authors === "mine" && !mine) return no("not-own");
  const skip = new Set(rules.skipLabels.map((l) => l.toLowerCase()));
  if (pr.labels.some((l) => skip.has(l.toLowerCase()))) return no("label");
  if (rules.baseBranches.length > 0 && !rules.baseBranches.includes(pr.baseRef)) return no("base-branch");
  if (i.reviewedSha === pr.headSha) return no("already-reviewed");
  if (i.failuresOnHead >= rules.maxFailures) return no("too-many-failures");
  const age = i.now - i.firstSeenAt;
  if (age < rules.settleMs) return no("settling");
  if (i.ci === "running" && rules.ciMaxWaitMs > 0 && age < rules.ciMaxWaitMs) return no("ci-running");
  return { eligible: true };
}

/** Where an inline comment can go: a line on the new side of the diff. Others go into the summary. */
export function splitInline<T extends { path: string; line: number }>(
  items: readonly T[],
  rightLines: (path: string) => ReadonlySet<number> | undefined,
): { inline: T[]; outside: T[] } {
  const inline: T[] = [];
  const outside: T[] = [];
  for (const it of items) (rightLines(it.path)?.has(it.line) ? inline : outside).push(it);
  return { inline, outside };
}
