import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES, reviewEligibility, splitInline, type EligibilityInput, type PullRequest } from "../src/index.ts";

const pr = (p: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  title: "Add search",
  body: "",
  author: "ana",
  authorIsBot: false,
  draft: false,
  state: "open",
  headSha: "h2",
  headRef: "feature",
  baseRef: "main",
  labels: [],
  updatedAt: "2026-11-19T10:00:00Z",
  url: "https://example.com/pr/7",
  fromFork: false,
  ...p,
});

const input = (p: Partial<EligibilityInput> = {}): EligibilityInput => ({
  pr: pr(),
  me: "Quost",
  rules: DEFAULT_RULES,
  failuresOnHead: 0,
  firstSeenAt: 0,
  now: 60 * 60_000,
  ci: "green",
  ...p,
});

describe("review eligibility", () => {
  test("a settled, green pull request from someone else is reviewed", () => {
    expect(reviewEligibility(input())).toEqual({ eligible: true });
  });

  test("each rule skips with its reason", () => {
    const cases: [Partial<EligibilityInput>, string][] = [
      [{ pr: pr({ state: "merged" }) }, "closed"],
      [{ pr: pr({ draft: true }) }, "draft"],
      [{ pr: pr({ authorIsBot: true }) }, "bot-author"],
      [{ pr: pr({ author: "quost" }) }, "own"],
      [{ rules: { ...DEFAULT_RULES, authors: "mine" } }, "not-own"],
      [{ pr: pr({ labels: ["No-AI-Review"] }) }, "label"],
      [{ rules: { ...DEFAULT_RULES, baseBranches: ["develop"] } }, "base-branch"],
      [{ reviewedSha: "h2" }, "already-reviewed"],
      [{ failuresOnHead: 2 }, "too-many-failures"],
      [{ firstSeenAt: 60 * 60_000 - 1000 }, "settling"],
      [{ ci: "running", firstSeenAt: 50 * 60_000 }, "ci-running"],
    ];
    for (const [over, reason] of cases) expect(reviewEligibility(input(over))).toEqual({ eligible: false, reason } as never);
  });

  test("own pull requests when asked, and CI waits only so long", () => {
    expect(reviewEligibility(input({ pr: pr({ author: "Quost" }), rules: { ...DEFAULT_RULES, authors: "all" } })).eligible).toBe(true);
    expect(reviewEligibility(input({ ci: "running", firstSeenAt: 0, now: 46 * 60_000 })).eligible).toBe(true);
    expect(reviewEligibility(input({ reviewedSha: "h1" })).eligible).toBe(true);
  });

  test("inline only on lines the diff shows", () => {
    const lines = new Map([["a.ts", new Set([3, 4])]]);
    const r = splitInline([{ path: "a.ts", line: 3 }, { path: "a.ts", line: 9 }, { path: "b.ts", line: 1 }], (p) => lines.get(p));
    expect(r.inline).toEqual([{ path: "a.ts", line: 3 }]);
    expect(r.outside).toHaveLength(2);
  });
});
