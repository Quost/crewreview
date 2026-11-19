import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { patchFingerprint, redactSecrets, type ExistingComment, type PullRequest } from "@crewreview/core";
import { gitAuthEnv, type Checks, type HostAdapter, type Thread } from "@crewreview/hosts";
import type { Harness } from "@crewreview/harness";
import { createTranslator, languageName, matchLocale, type Translator } from "@crewreview/i18n";
import type { Config } from "./config.ts";
import type { ConformanceStore } from "./conformance-store.ts";
import { diffText, mergeBase, resolveRef } from "./git.ts";
import { isPickError, pickReviewer, type PickError } from "./harnesses.ts";
import { BUILTIN_LENS_IDS, loadLenses } from "./lenses.ts";
import { fetchPull, isAncestor } from "./mirror.ts";
import type { AppDirs } from "./paths.ts";
import { renderHostReview, reviewedHeadsOnHost } from "./publish.ts";
import { renderMarkdown } from "./report.ts";
import type { LinkedRepo } from "./repos.ts";
import { ReviewError, runReview, type ReviewEvent, type ReviewReport } from "./review.ts";
import type { Store } from "./state.ts";

export interface PrDeps {
  dirs: AppDirs;
  config: Config;
  store: Store;
  conformance: ConformanceStore;
  registry: Map<string, Harness>;
  version: string;
  /** Interface language, for the local report. */
  ui: Translator;
  signal?: AbortSignal;
  onEvent?: (e: ReviewEvent) => void;
  /** Like onEvent, with the job it belongs to (the daemon uses it for the live board). */
  onJobEvent?: (job: JobRef, e: ReviewEvent) => void;
}

export interface JobRef {
  repo: string;
  number: number;
  title: string;
  kind: "review" | "attend";
}

export interface PrTarget {
  repo: LinkedRepo;
  host: HostAdapter;
  token: string;
}

export type PrMode = "inbox" | "auto" | "dry-run";

export type PrOutcome =
  | { kind: "skipped"; reason: "merge-only" | "already-on-host"; reviewId?: number }
  | { kind: "pending"; reviewId: number; findings: number; event: string }
  | { kind: "posted"; reviewId: number; url?: string; event: string; findings: number }
  | { kind: "stale"; reviewId: number }
  | { kind: "failed"; reviewId?: number; error: string }
  | { kind: "harness"; error: PickError }
  | { kind: "dry-run"; report: ReviewReport };

const MAX_COMMENT = 2000;

function threadsMarkdown(threads: readonly Thread[]): string {
  const out = ["# Discussion so far", ""];
  for (const th of threads.slice(0, 80)) {
    const where = th.path ? `${th.path}${th.line ? `:${th.line}` : ""}` : "conversation";
    out.push(`## ${where}${th.resolved ? " (resolved)" : ""}${th.outdated ? " (outdated)" : ""}`);
    for (const c of th.comments.slice(0, 20)) {
      const body = redactSecrets(c.body.length > MAX_COMMENT ? `${c.body.slice(0, MAX_COMMENT)} […]` : c.body);
      out.push(`- **${c.author}**${c.authorIsBot ? " (bot)" : ""}: ${body.replace(/\n/g, "\n  ")}`);
    }
    out.push("");
  }
  return out.join("\n");
}

function prMarkdown(pr: PullRequest): string {
  return [
    `# ${redactSecrets(pr.title)}`,
    "",
    `- Author: ${pr.author}${pr.fromFork ? " (from a fork)" : ""}`,
    `- ${pr.headRef} → ${pr.baseRef}`,
    pr.labels.length ? `- Labels: ${pr.labels.join(", ")}` : "",
    "",
    "## Description (written by the author)",
    "",
    redactSecrets(pr.body.trim() || "(empty)"),
    "",
  ].filter((l) => l !== null).join("\n");
}

function checksMarkdown(c: Checks): string {
  const lines = ["# CI of the reviewed head", "", `State: ${c.state}`];
  for (const f of c.failing) lines.push(`- failed: ${f.name}${f.allowedToFail ? " (allowed to fail — a failure here is still a failure, not a pass)" : ""}`);
  return lines.join("\n") + "\n";
}

function existing(threads: readonly Thread[]): ExistingComment[] {
  return threads.map((th) => ({ path: th.path, line: th.line, body: th.comments.map((c) => c.body).join("\n"), resolved: th.resolved }));
}

export function commentTranslator(repo: LinkedRepo, config: Config, ui: Translator): { t: Translator; language: string } {
  const code = repo.review.commentLanguage ?? config.review.commentLanguage ?? ui.locale;
  return { t: createTranslator(matchLocale(code) ?? "en"), language: languageName(code) };
}

/** Review one pull request: fetch it into the mirror, run the crew, then post or park it in the inbox. */
export async function reviewPullRequest(d: PrDeps, x: PrTarget, number: number, mode: PrMode, opts: { force?: boolean } = {}): Promise<PrOutcome> {
  const { repo, host } = x;
  const pr = await host.getPullRequest(number);
  const [threads, reviews] = await Promise.all([host.listThreads(number), host.listReviews(number)]);
  if (!opts.force && mode !== "dry-run" && reviewedHeadsOnHost(threads, reviews.map((r) => r.body)).has(pr.headSha)) {
    const id = d.store.start({ repo: repo.id, number, title: pr.title, url: pr.url, headSha: pr.headSha });
    d.store.update(id, { status: "skipped", note: "already-on-host" });
    return { kind: "skipped", reason: "already-on-host", reviewId: id };
  }

  const harness = await pickReviewer(d.registry, repo.review.harness ?? d.config.harness.default, d.conformance);
  if (isPickError(harness)) return { kind: "harness", error: harness };
  const verifierId = repo.review.verifier ?? d.config.harness.verifier;
  const verifier = verifierId ? await pickReviewer(d.registry, verifierId, d.conformance) : harness;
  if (isPickError(verifier)) return { kind: "harness", error: verifier };

  const reviewId = mode === "dry-run" ? undefined : d.store.start({ repo: repo.id, number, title: pr.title, url: pr.url, headSha: pr.headSha });
  // An older review still waiting in the inbox describes code that's gone.
  if (reviewId !== undefined) d.store.staleOthers(repo.id, number, reviewId);
  try {
    const fetched = await fetchPull({
      dataDir: d.dirs.data,
      repo: repo.ref,
      authEnv: gitAuthEnv(repo.ref, x.token),
      reference: repo.clone,
      number,
      baseRef: pr.baseRef,
      headRefspec: (local) => host.headRefspec(number, local),
    });
    const headSha = fetched.headSha;
    if (reviewId !== undefined && headSha !== pr.headSha) d.store.update(reviewId, { headSha });

    const mb = await mergeBase(fetched.mirror, fetched.baseSha, headSha);
    const signature = patchFingerprint(await diffText(fetched.mirror, mb, headSha));
    const last = d.store.lastReviewed(repo.id, number);
    if (!opts.force && last?.signature && last.headSha !== headSha && last.signature === signature) {
      if (reviewId !== undefined) d.store.update(reviewId, { status: "skipped", note: "merge-only", signature });
      return { kind: "skipped", reason: "merge-only", reviewId };
    }

    let deltaFrom: string | undefined;
    let deltaPatch: string | undefined;
    if (last?.status === "posted" && last.headSha !== headSha && (await resolveRef(fetched.mirror, last.headSha)) && (await isAncestor(fetched.mirror, last.headSha, headSha))) {
      deltaFrom = last.headSha;
      deltaPatch = await diffText(fetched.mirror, last.headSha, headSha);
    }

    const checks = await host.getChecks({ ...pr, headSha });
    const { language } = commentTranslator(repo, d.config, d.ui);
    const all = await loadLenses(fetched.mirror, fetched.baseSha);
    const wanted = repo.review.lenses ?? d.config.review.lenses;
    const lenses = all.filter((l) => wanted.includes(l.id) || (l.source === "repo" && !BUILTIN_LENS_IDS.includes(l.id)));

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const extraContext: Record<string, string> = { "pr.md": prMarkdown(pr), "threads.md": threadsMarkdown(threads), "checks.md": checksMarkdown(checks) };
    if (deltaPatch) extraContext["delta.patch"] = deltaPatch;

    const report = await runReview(
      {
        target: { root: fetched.mirror, branch: pr.headRef, base: pr.baseRef, baseSha: fetched.baseSha, headSha, rulesRef: fetched.baseSha, ci: checks.state },
        jobDir: join(d.dirs.state, "runs", `${repo.id}-${number}-${stamp}`),
        lenses,
        partial: false,
        harness,
        verifier,
        config: d.config,
        language,
        policy: { ...d.config.review.policy, allowApprove: repo.review.allowApprove ?? d.config.review.policy.allowApprove },
        existingComments: existing(threads),
        extraContext,
        deltaFrom,
        signal: d.signal,
        onEvent: d.onEvent,
      },
      d.version,
    );
    await writeFile(join(report.jobDir, "report.md"), renderMarkdown(report, d.ui));
    if (mode === "dry-run") return { kind: "dry-run", report };

    d.store.update(reviewId!, { jobDir: report.jobDir, findings: report.findings.length, event: report.verdict.event, signature });
    if (mode === "inbox") {
      d.store.update(reviewId!, { status: "pending" });
      return { kind: "pending", reviewId: reviewId!, findings: report.findings.length, event: report.verdict.event };
    }
    return await postReview(d, x, reviewId!);
  } catch (e) {
    const error = e instanceof ReviewError && e.code === "all-lenses-failed" ? `${e.details.failure}: every lens failed` : e instanceof Error ? e.message : String(e);
    if (reviewId !== undefined) d.store.update(reviewId, { status: "failed", error: error.slice(0, 2000) });
    return { kind: "failed", reviewId, error };
  }
}

/** Post a finished review. Refuses when the pull request moved on since: the review would describe old code. */
export async function postReview(d: PrDeps, x: PrTarget, reviewId: number): Promise<PrOutcome> {
  const row = d.store.get(reviewId);
  if (!row?.jobDir) return { kind: "failed", reviewId, error: "no report for this review" };
  const report = JSON.parse(await readFile(join(row.jobDir, "report.json"), "utf8")) as ReviewReport;
  const pr = await x.host.getPullRequest(row.number);
  if (pr.headSha !== row.headSha) {
    d.store.update(reviewId, { status: "stale" });
    return { kind: "stale", reviewId };
  }
  const { t } = commentTranslator(x.repo, d.config, d.ui);
  const rendered = await renderHostReview(report, t, d.version);
  try {
    const r = await x.host.postReview(pr, rendered);
    d.store.update(reviewId, { status: "posted", postedUrl: r.url ?? pr.url, event: r.event });
    return { kind: "posted", reviewId, url: r.url ?? pr.url, event: r.event, findings: report.findings.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // From the inbox it stays there to retry; an automatic post that failed counts as a failed run.
    d.store.update(reviewId, { error: error.slice(0, 2000), status: row.status === "pending" ? "pending" : "failed" });
    return { kind: "failed", reviewId, error };
  }
}
