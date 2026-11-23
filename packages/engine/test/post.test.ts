import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type Finding } from "@crewreview/core";
import { createTranslator } from "@crewreview/i18n";
import { renderHostReview, type ReviewReport } from "../src/index.ts";

const f = (id: string, severity: Finding["severity"], line: number): Finding => ({ id, lens: "tests", lenses: ["tests"], path: "src/a.ts", line, severity, title: `title ${id}`, body: "body", confidence: "high" });

test("the post opens with the trust seal and what it rests on, in the chosen style, and lists extra nits once", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "crewreview-post-"));
  try {
    await mkdir(join(jobDir, "ctx"));
    const hunk = Array.from({ length: 6 }, (_, i) => `+line ${i + 1}`).join("\n");
    await writeFile(join(jobDir, "ctx", "diff.patch"), `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,6 @@\n${hunk}\n`);
    const findings = [f("F1", "major", 1), f("F2", "nit", 2), f("F3", "nit", 3), f("F4", "nit", 4)];
    const report = {
      version: "test",
      promptVersion: "6",
      target: { branch: "b", base: "main", baseSha: "a".repeat(40), headSha: "1234567890abcdef1234567890abcdef12345678", rulesRef: "x", ci: "green", mergeBaseSha: "a".repeat(40) },
      lenses: [{ lens: "tests", harness: "kiro", status: "ok", findings, coverage: "full", uncovered: [], durationMs: 1 }],
      findings,
      verifier: { ran: true, ok: true, dropped: [], downgraded: 0 },
      verdict: { event: "comment", reasons: ["approve-disabled"], counts: { blocker: 0, major: 1, minor: 0, nit: 3 } },
      trust: { level: "partial", reasons: ["major-open"] },
      jobDir,
    } as unknown as ReviewReport;
    const t = createTranslator("en");
    const r = await renderHostReview(report, t, "test", { severityStyle: "tupi", maxNits: 1 });
    const lines = r.body.split("\n");
    expect(lines[2]).toBe("**🟡 Trust: partial** · Reviewed up to `1234567`.");
    expect(lines[3]).toBe("Because: a major finding is still open.");
    expect(r.body).toContain("⚠️ major: 1");
    // One nit inline, the other two listed once in the summary.
    expect(r.comments.map((c) => c.line)).toEqual([1, 2]);
    expect(r.comments[1]!.body.startsWith("💅")).toBe(true);
    expect(r.body).toContain("<summary>2 more nits, listed here</summary>");
    expect(r.body).toContain("- 💅 `src/a.ts:3` title F3");
    expect(DEFAULT_POLICY.requestChangesAt).toBe("blocker");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
