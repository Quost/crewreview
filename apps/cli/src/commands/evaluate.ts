import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizeEval, type EvalScore } from "@crewreview/core";
import { connect, findLinked, loadEvalCases, loadRepos, PROMPT_VERSION, reposFile, runEvalCase } from "@crewreview/engine";
import type { Ctx } from "../ctx.ts";
import { findRepo, noTokenText } from "./repo.ts";
import { deps } from "./review.ts";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Review each calibration case at its pinned commits and score it: what it had to find, what it must not claim. The
 * cases describe your code, so they live in your config folder (eval/), and so do the results.
 */
export async function evaluate(c: Ctx, dirArg: string | undefined, only: string | undefined): Promise<number> {
  const { t, style: st } = c;
  const dir = dirArg ?? join(c.dirs.config, "eval");
  const { cases, errors } = await loadEvalCases(dir);
  for (const e of errors) c.err(st.red(t.t("eval.badCase", { file: e.file, error: e.error })));
  const picked = cases.filter((x) => !only || only.split(",").includes(x.case.id));
  if (picked.length === 0) return (c.err(t.t("eval.none", { dir })), errors.length ? 2 : 1);

  const d = deps(c, undefined, true);
  const scores: EvalScore[] = [];
  const results: unknown[] = [];
  try {
    for (const { case: ec } of picked) {
      c.err(st.dim(t.t("eval.running", { id: ec.id, repo: ec.repo, number: ec.number, head: ec.head.slice(0, 8) })));
      // A repository of an organization or group link is found by the pull request's address.
      const linked = ec.url ? findLinked(await loadRepos(reposFile(c.dirs)), ec.repo, ec.url) : undefined;
      const repo = linked ?? (await findRepo(c, ec.repo));
      if (typeof repo === "string") {
        c.err(st.red(repo));
        continue;
      }
      const target = await connect(repo, c.version);
      if ("error" in target) {
        c.err(st.red(noTokenText(c, repo)));
        continue;
      }
      const r = await runEvalCase(d, target, ec).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      if ("error" in r) {
        c.err(st.red(t.t("eval.failed", { id: ec.id, error: r.error })));
        continue;
      }
      const s = r.score;
      scores.push(s);
      const tone = s.falsePositives.length ? st.red : s.missed.length ? st.yellow : st.green;
      c.out(tone(t.t("eval.case", { id: s.id, found: s.found.length, must: s.found.length + s.underrated.length + s.missed.length, findings: s.findings })));
      if (s.underrated.length) c.out(`  ${st.yellow(t.t("eval.underrated", { list: s.underrated.join(", ") }))}`);
      if (s.missed.length) c.out(`  ${t.t("eval.missed", { list: s.missed.join(", ") })}`);
      if (s.falsePositives.length) c.out(`  ${st.red(t.t("eval.falsePositives", { list: s.falsePositives.join(", ") }))}`);
      results.push({ ...s, jobDir: r.report.jobDir, findings: r.report.findings.map((f) => ({ path: f.path, line: f.line, severity: f.severity, lens: f.lens, title: f.title })), verdict: r.report.verdict });
    }
  } finally {
    d.close();
  }
  if (scores.length === 0) return 1;
  const sum = summarizeEval(scores);
  c.out();
  c.out(st.bold(t.t("eval.summary", { cases: sum.cases, recall: pct(sum.recall), underrated: sum.underrated, falsePositives: sum.falsePositives, findings: sum.findingsPerReview, small: sum.smallPerReview, prompt: PROMPT_VERSION })));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = join(dir, "results", `${stamp}-p${PROMPT_VERSION}.json`);
  await mkdir(join(dir, "results"), { recursive: true });
  await writeFile(out, JSON.stringify({ version: c.version, promptVersion: PROMPT_VERSION, at: new Date().toISOString(), summary: sum, cases: results }, null, 2), { mode: 0o600 });
  c.out(st.dim(t.t("eval.saved", { path: out })));
  return sum.falsePositives > 0 ? 1 : 0;
}
