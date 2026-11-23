import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_LENS_IDS, loadLenses, localTarget, LocalTargetError, renderMarkdown, reviewKnobs, renderTerminal, ReviewError, runReview, type ReviewReport } from "@crewreview/engine";
import { languageName } from "@crewreview/i18n";
import { pickHarness, progress, type Ctx } from "../ctx.ts";

export interface LocalArgs {
  base?: string;
  uncommitted: boolean;
  harness?: string;
  verifierHarness?: string;
  lens?: string;
  verify: boolean;
  lang?: string;
  json: boolean;
}

export function reviewErrorText(c: Ctx, e: ReviewError, base: string, head: string): string {
  if (e.code === "no-changes") return c.t.t("error.noChanges", { base, head });
  if (e.code === "diff-too-large") return c.t.t("error.diffTooLarge", { lines: e.details.lines ?? "?", limit: e.details.limit ?? "?" });
  return c.t.t("error.allLensesFailed");
}

export interface LocalOptions extends LocalArgs {
  cwd?: string;
  onEvent?: Parameters<typeof runReview>[0]["onEvent"];
}

/** The review behind `crewreview local` and the MCP tool: returns the report, or a message for the user. */
export async function localReview(c: Ctx, a: LocalOptions): Promise<{ report: ReviewReport; reportPath: string } | { error: string }> {
  const { t, config } = c;
  const cwd = a.cwd ?? process.cwd();
  let target;
  try {
    target = await localTarget({ cwd, base: a.base, uncommitted: a.uncommitted });
  } catch (e) {
    if (!(e instanceof LocalTargetError)) throw e;
    return { error: e.code === "not-git-repo" ? t.t("error.notGitRepo", { path: cwd }) : e.code === "no-base" ? t.t("error.noBase") : t.t("error.badRef", { ref: e.details.ref ?? "?" }) };
  }
  const harness = await pickHarness(c, a.harness ?? config.harness.default);
  if (typeof harness === "string") return { error: harness };
  const verifierId = a.verifierHarness ?? config.harness.verifier;
  const verifier = verifierId ? await pickHarness(c, verifierId) : harness;
  if (typeof verifier === "string") return { error: verifier };

  const all = await loadLenses(target.root, target.rulesRef);
  const known = all.map((l) => l.id);
  const knobs = reviewKnobs(config);
  const wanted = a.lens ? a.lens.split(",").map((s) => s.trim()).filter(Boolean) : knobs.lenses;
  for (const id of wanted) if (!known.includes(id)) return { error: t.t("error.unknownLens", { name: id, list: known.join(", ") }) };
  const extra = a.lens ? [] : all.filter((l) => l.source === "repo" && !BUILTIN_LENS_IDS.includes(l.id)).map((l) => l.id);
  const lenses = all.filter((l) => wanted.includes(l.id) || extra.includes(l.id));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jobDir = join(c.dirs.state, "runs", `local-${stamp}-${target.headSha.slice(0, 8)}`);
  try {
    const report = await runReview(
      {
        target,
        jobDir,
        lenses,
        partial: a.lens !== undefined,
        harness,
        verifier,
        config: { ...config, review: { ...config.review, verifier: a.verify && config.review.verifier, verifierRaise: knobs.verifierRaise } },
        language: languageName(a.lang ?? config.review.commentLanguage ?? t.locale),
        policy: knobs.policy,
        onEvent: a.onEvent,
      },
      c.version,
    );
    const reportPath = join(jobDir, "report.md");
    await writeFile(reportPath, renderMarkdown(report, t));
    return { report, reportPath };
  } catch (e) {
    if (e instanceof ReviewError) return { error: reviewErrorText(c, e, target.base, target.branch) };
    throw e;
  }
}

export async function local(c: Ctx, a: LocalArgs): Promise<number> {
  const r = await localReview(c, { ...a, onEvent: a.json ? undefined : progress(c) });
  if ("error" in r) return (c.err(r.error), 2);
  if (a.json) c.out(JSON.stringify(r.report, null, 2));
  else {
    c.err();
    c.out(renderTerminal(r.report, c.t, c.style));
    c.out(c.style.dim(`${c.t.t("local.report")}: ${r.reportPath}`));
  }
  return 0;
}
