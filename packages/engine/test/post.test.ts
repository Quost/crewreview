import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, parseMarker, type Finding } from "@crewreview/core";
import { createTranslator } from "@crewreview/i18n";
import { renderHostReview, type ReviewReport } from "../src/index.ts";

const f = (id: string, severity: Finding["severity"], line: number): Finding => ({ id, lens: "tests", lenses: ["tests"], path: "src/a.ts", line, severity, title: `title ${id}`, body: "body", confidence: "high" });

test("the post opens with the trust seal and what it rests on, in the chosen style, and lists extra nits once", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "crewreview-post-"));
  try {
    await mkdir(join(jobDir, "ctx"));
    const hunk = Array.from({ length: 6 }, (_, i) => `+line ${i + 1}`).join("\n");
    await writeFile(join(jobDir, "ctx", "diff.patch"), `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,6 @@\n${hunk}\n`);
    const findings = [{ ...f("F1", "major", 1), scenario: "A retry after a 5xx sends the command twice." }, f("F2", "nit", 2), f("F3", "nit", 3), f("F4", "nit", 4), { ...f("F5", "minor", 5), confidence: "low" as const, capped: { from: "major" as const, reason: "no-scenario" as const } }];
    const report = {
      version: "test",
      promptVersion: "6",
      target: { branch: "b", base: "main", baseSha: "a".repeat(40), headSha: "1234567890abcdef1234567890abcdef12345678", rulesRef: "x", ci: "green", mergeBaseSha: "a".repeat(40) },
      lenses: [{ lens: "tests", harness: "kiro", status: "ok", findings, coverage: "full", uncovered: [], durationMs: 1 }],
      findings,
      verifier: { ran: true, ok: true, dropped: [], downgraded: 0 },
      verdict: { event: "comment", reasons: ["approve-disabled"], counts: { blocker: 0, major: 1, minor: 0, nit: 3 } },
      trust: { level: "partial", reasons: ["major-open"] },
      reviewGuide: ".crewreview/REVIEW.md",
      checks: [
        { kind: "claim", text: "Idempotent by deal_id", source: "docs/integration.md", status: "holds", evidence: "scripts/b.mjs:10" },
        { kind: "rule", text: "New settings go to DEPLOY.md", status: "fails", evidence: "docs/DEPLOY.md:3" },
        { kind: "claim", text: "Only the worker writes <ids>", source: "pr", status: "unverified", unproven: true },
      ],
      jobDir,
    } as unknown as ReviewReport;
    const t = createTranslator("en");
    const r = await renderHostReview(report, t, "test", { severityStyle: "signs", maxNits: 1 });
    const lines = r.body.split("\n");
    expect(lines[2]).toBe("**🟡 Trust: partial** · Reviewed up to `1234567`.");
    expect(lines[3]).toBe("Because: a major finding is still open.");
    expect(r.body).toContain("⚠️ major: 1");
    // One nit inline, the other two listed once in the summary.
    expect(r.comments.map((c) => c.line)).toEqual([1, 2]);
    expect(r.comments[1]!.body.startsWith("💅")).toBe(true);
    expect(r.body).toContain("<summary>2 more nits, listed here</summary>");
    expect(r.body).toContain("- 💅 `src/a.ts:3` title F3");
    expect(r.comments[0]!.body).toContain("**Scenario:** A retry after a 5xx sends the command twice.");
    // Low confidence: a question in the summary, not a comment on a line.
    expect(r.comments.some((c) => c.line === 5)).toBe(false);
    expect(r.body).toContain("#### Not confirmed: questions, not findings");
    expect(r.body).toContain("`src/a.ts:5` **title F5**");
    // What was checked, counted by code, failures first.
    expect(r.body).toContain("<summary>Claims and rules checked against the code: ✅ 1 · ❌ 1 · ❔ 1</summary>");
    const checks = lines.filter((l) => /^- (✅|❌|❔)/.test(l));
    expect(checks).toEqual([
      "- ❌ New settings go to DEPLOY.md (rule) · `docs/DEPLOY.md:3`",
      "- ❔ Only the worker writes ids (claim, pr) · no place in the code was given",
      "- ✅ Idempotent by deal_id (claim, docs/integration.md) · `scripts/b.mjs:10`",
    ]);
    // Which review guidance the crew followed.
    expect(lines).toContain("- Followed the team's review guidance in `.crewreview/REVIEW.md`");
    expect(DEFAULT_POLICY.requestChangesAt).toBe("blocker");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

async function render(findings: Finding[], extra: Partial<ReviewReport> = {}, maxNits = Number.POSITIVE_INFINITY) {
  const jobDir = await mkdtemp(join(tmpdir(), "crewreview-post-"));
  try {
    await mkdir(join(jobDir, "ctx"));
    const hunk = Array.from({ length: 6 }, (_, i) => `+line ${i + 1}`).join("\n");
    await writeFile(join(jobDir, "ctx", "diff.patch"), `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,6 @@\n${hunk}\n`);
    const report = {
      version: "test",
      promptVersion: "6",
      target: { branch: "b", base: "main", baseSha: "a".repeat(40), headSha: "1234567890abcdef1234567890abcdef12345678", rulesRef: "x", ci: "green", mergeBaseSha: "a".repeat(40) },
      lenses: [{ lens: "tests", harness: "kiro", status: "ok", findings, coverage: "full", uncovered: [], durationMs: 1 }],
      findings,
      repeated: [],
      coveredByThreads: 0,
      droppedByEvidence: 0,
      verifier: { ran: true, ok: true, dropped: [], downgraded: 0 },
      verdict: { event: "comment", reasons: ["approve-disabled"], counts: { blocker: 0, major: 0, minor: 0, nit: 0 } },
      jobDir,
      ...extra,
    } as unknown as ReviewReport;
    return await renderHostReview(report, createTranslator("en"), "test", { severityStyle: "crewreview", maxNits });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

test("an inline comment keeps the statement on top and folds why it was flagged below", async () => {
  const finding: Finding = {
    ...f("F1", "major", 2),
    title: "Retry sends the charge twice",
    body: "The retry loop calls `charge()` again after a timeout.",
    scenario: "The gateway answers after 31 s: the <retry> fires and the card is charged twice.",
    evidence: "await charge(order) // ```",
    verification: { action: "upgrade", from: "minor", evidence: "src/a.ts:4", reason: "Nothing makes charge idempotent." },
  };
  const r = await render([finding]);
  expect(r.comments[0]!.body).toBe(
    [
      "🟠 **major** · tests — **Retry sends the charge twice**",
      "",
      "The retry loop calls `charge()` again after a timeout.",
      "",
      "<details><summary>Why this was flagged</summary>",
      "",
      "**Scenario:** The gateway answers after 31 s: the &lt;retry&gt; fires and the card is charged twice.",
      "",
      "**Evidence:**",
      "",
      "````",
      "await charge(order) // ```",
      "````",
      "",
      "The verifier raised it from minor, see `src/a.ts:4`: Nothing makes charge idempotent.",
      "",
      "</details>",
      "",
      "<sub>https://crewreview.ai?ref=github · high confidence · raised from minor by the verifier, see src/a.ts:4</sub>",
      "<!-- crewreview:kind=finding;v=test;ref=F1%401234567890ab -->",
    ].join("\n"),
  );
  // The markers a later run reads still parse from the new bodies.
  expect(parseMarker(r.comments[0]!.body)).toEqual({ kind: "finding", version: "test", ref: "F1@1234567890ab" });
  expect(parseMarker(r.body)).toEqual({ kind: "review", version: "test", ref: "1234567890abcdef1234567890abcdef12345678" });
});

test("a finding with nothing to explain stays a short comment, without an empty fold", async () => {
  const r = await render([{ ...f("F1", "minor", 1), verification: { action: "confirm", reason: "  " } }]);
  expect(r.comments[0]!.body).not.toContain("<details>");
  expect(r.comments[0]!.body).toContain("high confidence · verified");
});

test("the verifier's confirmation and downgrade are explained in the fold", async () => {
  const r = await render([
    { ...f("F1", "minor", 1), verification: { action: "confirm", reason: "The guard is missing on this path." } },
    { ...f("F2", "minor", 2), verification: { action: "downgrade", from: "major", reason: "Only the admin job reaches it." } },
  ]);
  expect(r.comments[0]!.body).toContain("The verifier checked the code and confirmed it: The guard is missing on this path.");
  expect(r.comments[1]!.body).toContain("The verifier lowered it from major: Only the admin job reaches it.");
});

test("summary entries outside the diff fold their reasoning inside the list item", async () => {
  const r = await render([{ ...f("F1", "major", 40), body: "Line one.\nLine two.", scenario: "Two workers pick the same job." }]);
  expect(r.comments).toEqual([]);
  const at = r.body.indexOf("- 🟠 `src/a.ts:40` **title F1**");
  expect(at).toBeGreaterThan(-1);
  expect(r.body.slice(at).split("\n").slice(0, 10)).toEqual([
    "- 🟠 `src/a.ts:40` **title F1**",
    "",
    "  Line one.",
    "  Line two.",
    "",
    "  <details><summary>Why this was flagged</summary>",
    "",
    "  **Scenario:** Two workers pick the same job.",
    "",
    "  </details>",
  ]);
});

test("a re-review says, one line per reason, what it left out and why", async () => {
  const repeated = [f("R1", "minor", 1), f("R2", "minor", 2), { ...f("R3", "major", 3), title: "Still racy" }, f("R4", "nit", 4)];
  const extra = {
    repeated,
    coveredByThreads: repeated.length,
    droppedByEvidence: 1,
    droppedUnread: 2,
    delta: "abcdef1234567",
    verifier: { ran: true, ok: true, dropped: [f("D1", "minor", 1)], downgraded: 0 },
  } as Partial<ReviewReport>;
  const r = await render([f("F1", "nit", 1), f("F2", "nit", 2), f("F3", "nit", 3)], extra, 1);
  const notes = r.body.split("\n").filter((l) => l.startsWith("- ") && !l.includes("`src/"));
  expect(notes).toEqual([
    "- 4 findings already raised earlier are not repeated (1 major, 2 minor, 1 nit).",
    "- 2 nits past the limit of 1 per review are listed below instead of on their lines.",
    "- 1 finding was dropped for citing a file or line that doesn't exist.",
    "- 2 findings were dropped because their lens said it couldn't read those files.",
    "- The verifier discarded 1 finding after checking the code.",
  ]);
  expect(r.body).toContain("Focused on what changed since abcdef1, the last commit reviewed.");
  expect(r.body).toContain("#### Still open from the discussion\n\n- 🟠 `src/a.ts:3` Still racy");
  expect(r.comments.map((c) => c.line)).toEqual([1]);
});
