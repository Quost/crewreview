import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, decideVerdict, resolveReview, trustLevel, type LensResult, type TrustInput } from "../src/index.ts";

const lens = (p: Partial<LensResult> = {}): LensResult => ({ lens: "correctness", harness: "kiro", status: "ok", findings: [], coverage: "full", uncovered: [], durationMs: 1, ...p });
const base: TrustInput = { findings: [], lenses: [lens()], ci: "green", changedLines: 100, maxChangedLines: 1500, verifierRan: true, partial: false, leftOut: 0 };

describe("trust in a review", () => {
  test.each([
    ["everything read, verified, CI green, nothing big open", {}, "trusted", []],
    ["no CI at all counts as green", { ci: "none" as const }, "trusted", []],
    ["a blocker open", { findings: [{ severity: "blocker" as const }] }, "untrusted", ["blocker-open"]],
    ["CI red", { ci: "red" as const }, "untrusted", ["ci-red"]],
    ["too large", { changedLines: 2000 }, "untrusted", ["too-large"]],
    ["a major open", { findings: [{ severity: "major" as const }, { severity: "nit" as const }] }, "partial", ["major-open"]],
    ["a lens failed", { lenses: [lens(), lens({ lens: "security", status: "failed" })] }, "partial", ["lens-failed"]],
    ["partial without saying what", { lenses: [lens({ coverage: "partial" })] }, "partial", ["lens-failed"]],
    ["a file no lens read", { lenses: [lens({ coverage: "partial", uncovered: ["docs/STATUS.md"] })] }, "partial", ["files-unread"]],
    ["a diff too large to give the agents", { leftOut: 1 }, "partial", ["files-left-out"]],
    ["no verifier", { verifierRan: false }, "partial", ["verifier-missing"]],
    ["only some lenses asked", { partial: true }, "partial", ["some-lenses"]],
    ["CI still running", { ci: "running" as const }, "partial", ["ci-pending"]],
  ])("%s", (_name, change, level, reasons) => {
    expect(trustLevel({ ...base, ...change })).toEqual({ level, reasons } as never);
  });

  test("the worst level wins, with only its reasons", () => {
    expect(trustLevel({ ...base, ci: "red", verifierRan: false, findings: [{ severity: "major" }] })).toEqual({ level: "untrusted", reasons: ["ci-red"] });
  });
});

describe("what a review may do", () => {
  const input = { findings: [], lenses: [lens()], ci: "green" as const, changedLines: 10, verifierRan: true, partial: false };
  const blocker = { id: "F1", lens: "correctness", lenses: ["correctness"], path: "a.ts", line: 1, severity: "blocker" as const, title: "t", body: "b", confidence: "high" as const };

  test("never: a blocker comments instead of requesting changes", () => {
    expect(decideVerdict({ ...input, findings: [blocker] }, DEFAULT_POLICY).event).toBe("request_changes");
    expect(decideVerdict({ ...input, findings: [blocker] }, { ...DEFAULT_POLICY, requestChangesAt: "never" }).event).toBe("comment");
  });

  test("requireTrusted: no approval unless the review is trusted", () => {
    const policy = { ...DEFAULT_POLICY, allowApprove: true, requireTrusted: true };
    expect(decideVerdict({ ...input, trust: { level: "trusted", reasons: [] } }, policy).event).toBe("approve");
    expect(decideVerdict({ ...input, trust: { level: "partial", reasons: ["files-left-out"] } }, policy)).toMatchObject({ event: "comment", reasons: ["not-trusted"] });
  });
});

describe("a repository's review settings", () => {
  const global = { profile: "standard" as const, lenses: ["correctness", "contracts", "tests"], verifierRaise: true, policy: DEFAULT_POLICY, severityStyle: "crewreview" as const, maxNits: 5 };

  test("its own values over the global ones; unset follows them", () => {
    const r = resolveReview(global, { requestChangesAt: "never", allowApprove: true, severityStyle: "tupi", maxNits: 2 });
    expect(r).toMatchObject({ profile: "standard", lenses: global.lenses, severityStyle: "tupi", maxNits: 2, policy: { requestChangesAt: "never", allowApprove: true, approveBlockedAt: "major" } });
    expect(resolveReview(global)).toEqual(global);
  });

  test("fast trims the contracts lens and the verifier's raises, unless the repository lists its lenses", () => {
    expect(resolveReview(global, { profile: "fast" })).toMatchObject({ lenses: ["correctness", "tests"], verifierRaise: false });
    expect(resolveReview(global, { profile: "fast", lenses: ["contracts"] }).lenses).toEqual(["contracts"]);
  });

  test("gate approves only a trusted review, unless the repository says otherwise", () => {
    expect(resolveReview(global, { profile: "gate" }).policy.requireTrusted).toBe(true);
    expect(resolveReview(global, { profile: "gate", requireTrusted: false }).policy.requireTrusted).toBe(false);
  });
});
