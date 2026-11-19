import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_LENS_IDS, loadLenses, localTarget, LocalTargetError, renderMarkdown, renderTerminal, ReviewError, runReview } from "@crewreview/engine";
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

export async function local(c: Ctx, a: LocalArgs): Promise<number> {
  const { t, config } = c;
  let target;
  try {
    target = await localTarget({ cwd: process.cwd(), base: a.base, uncommitted: a.uncommitted });
  } catch (e) {
    if (!(e instanceof LocalTargetError)) throw e;
    c.err(e.code === "not-git-repo" ? t.t("error.notGitRepo", { path: process.cwd() }) : e.code === "no-base" ? t.t("error.noBase") : t.t("error.badRef", { ref: e.details.ref ?? "?" }));
    return 2;
  }
  const harness = await pickHarness(c, a.harness ?? config.harness.default);
  if (typeof harness === "string") return (c.err(harness), 2);
  const verifierId = a.verifierHarness ?? config.harness.verifier;
  const verifier = verifierId ? await pickHarness(c, verifierId) : harness;
  if (typeof verifier === "string") return (c.err(verifier), 2);

  const all = await loadLenses(target.root, target.rulesRef);
  const known = all.map((l) => l.id);
  const wanted = a.lens ? a.lens.split(",").map((s) => s.trim()).filter(Boolean) : config.review.lenses;
  for (const id of wanted) if (!known.includes(id)) return (c.err(t.t("error.unknownLens", { name: id, list: known.join(", ") })), 2);
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
        config: { ...config, review: { ...config.review, verifier: a.verify && config.review.verifier } },
        language: languageName(a.lang ?? config.review.commentLanguage ?? t.locale),
        policy: config.review.policy,
        onEvent: a.json ? undefined : progress(c),
      },
      c.version,
    );
    const md = join(jobDir, "report.md");
    await writeFile(md, renderMarkdown(report, t));
    if (a.json) c.out(JSON.stringify(report, null, 2));
    else {
      c.err();
      c.out(renderTerminal(report, t, c.style));
      c.out(c.style.dim(`${t.t("local.report")}: ${md}`));
    }
    return 0;
  } catch (e) {
    if (e instanceof ReviewError) return (c.err(reviewErrorText(c, e, target.base, target.branch)), 2);
    throw e;
  }
}
