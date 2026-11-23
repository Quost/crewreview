import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvalCase, scoreEval, type EvalCase, type EvalScore } from "@crewreview/core";
import { gitAuthEnv } from "@crewreview/hosts";
import { git, resolveRef } from "./git.ts";
import { isPickError, pickReviewer } from "./harnesses.ts";
import { BUILTIN_LENS_IDS, loadLenses } from "./lenses.ts";
import { fetchPull } from "./mirror.ts";
import { prMarkdown, type PrDeps, type PrTarget } from "./pr.ts";
import { pickLimits } from "./quota.ts";
import { runReview, type ReviewReport } from "./review.ts";
import { languageName } from "@crewreview/i18n";

/** Every case file under `dir` (`*.case.json`, any depth), parsed; a broken one is reported, not fatal. */
export async function loadEvalCases(dir: string): Promise<{ cases: { file: string; case: EvalCase }[]; errors: { file: string; error: string }[] }> {
  const cases: { file: string; case: EvalCase }[] = [];
  const errors: { file: string; error: string }[] = [];
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  for (const rel of entries.filter((e) => e.endsWith(".case.json")).sort()) {
    const file = join(dir, rel);
    try {
      const r = parseEvalCase(JSON.parse(await readFile(file, "utf8")));
      if (r.ok) cases.push({ file, case: r.case });
      else errors.push({ file, error: r.error });
    } catch (e) {
      errors.push({ file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { cases, errors };
}

/**
 * Review a case's pinned commits as a fresh review would, and score it. Nothing is posted and nothing is recorded as a
 * review. The threads on the pull request are left out on purpose: they hold the review being measured, and would
 * hide the very findings the case asks for.
 */
export async function runEvalCase(d: PrDeps, x: PrTarget, c: EvalCase): Promise<{ report: ReviewReport; score: EvalScore } | { error: string }> {
  const { repo, host } = x;
  const pr = await host.getPullRequest(c.number);
  const fetched = await fetchPull({
    dataDir: d.dirs.data,
    repo: repo.ref,
    authEnv: gitAuthEnv(repo.ref, x.token),
    reference: repo.clone,
    number: c.number,
    baseRef: pr.baseRef,
    headRefspec: (local) => host.headRefspec(c.number, local),
  });
  // The pinned commits may be gone from the branches by now (force-pushed, merged): fetch them by id.
  const pinned: string[] = [];
  for (const ref of [c.head, c.base]) {
    let sha = await resolveRef(fetched.mirror, `${ref}^{commit}`);
    if (!sha) {
      await git(["fetch", "--no-tags", "--quiet", "origin", ref], fetched.mirror, gitAuthEnv(repo.ref, x.token));
      sha = await resolveRef(fetched.mirror, `${ref}^{commit}`);
    }
    if (!sha) return { error: `commit ${ref} not found` };
    pinned.push(sha);
  }
  const [headSha, baseSha] = pinned as [string, string];

  const limits = pickLimits(d.config, d.quota);
  const harness = await pickReviewer(d.registry, repo.review.harness ?? d.config.harness.default, d.conformance, limits);
  if (isPickError(harness)) return { error: `harness: ${harness.error}` };
  const verifierId = repo.review.verifier ?? d.config.harness.verifier;
  const verifier = verifierId ? await pickReviewer(d.registry, verifierId, d.conformance, { ...limits, budget: undefined }) : harness;
  if (isPickError(verifier)) return { error: `verifier: ${verifier.error}` };

  const all = await loadLenses(fetched.mirror, baseSha);
  const wanted = c.lenses ?? repo.review.lenses ?? d.config.review.lenses;
  const lenses = all.filter((l) => wanted.includes(l.id) || (!c.lenses && l.source === "repo" && !BUILTIN_LENS_IDS.includes(l.id)));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // The language the real reviews were written in: the words a case looks for are in it.
  const code = c.language ?? repo.review.commentLanguage ?? d.config.review.commentLanguage ?? d.ui.locale;

  const report = await runReview(
    {
      target: { root: fetched.mirror, branch: pr.headRef, base: pr.baseRef, baseSha, headSha, rulesRef: baseSha, ci: "none" },
      jobDir: join(d.dirs.state, "runs", `eval-${c.id}-${stamp}`),
      lenses,
      partial: false,
      harness,
      verifier,
      config: d.config,
      language: languageName(code),
      policy: { ...d.config.review.policy, allowApprove: repo.review.allowApprove ?? d.config.review.policy.allowApprove },
      extraContext: { "pr.md": prMarkdown(pr) },
      guidelines: repo.review.guidelines,
      signal: d.signal,
      onEvent: d.onEvent,
    },
    d.version,
  );
  return { report, score: scoreEval(c, report.findings) };
}
