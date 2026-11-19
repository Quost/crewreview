import { acquireLock, connect, LockedError, loadRepos, nextInterval, registryFor, renderTerminal, reposFile, reviewPullRequest, runCycle, sleep, type DaemonEvent, type PrDeps, type PrOutcome } from "@crewreview/engine";
import { HostError } from "@crewreview/hosts";
import { conformanceStore, openStore, pickErrorText, progress, type Ctx } from "../ctx.ts";
import { findRepo, noTokenText } from "./repo.ts";

function deps(c: Ctx, signal?: AbortSignal, quiet = false): PrDeps & { close(): void } {
  const store = openStore(c);
  store.recoverInterrupted();
  return {
    dirs: c.dirs,
    config: c.config,
    store,
    conformance: conformanceStore(c),
    registry: registryFor(c.config),
    version: c.version,
    ui: c.t,
    signal,
    onEvent: quiet ? undefined : progress(c),
    close: () => store.close(),
  };
}

export function outcomeText(c: Ctx, repo: string, number: number, o: PrOutcome): string {
  const { t, style: st } = c;
  switch (o.kind) {
    case "posted":
      return st.green(t.t("review.posted", { repo, number, event: t.t(`verdict.${o.event}` as never), url: o.url ?? "" }));
    case "pending":
      return t.t("review.inboxed", { repo, number, id: o.reviewId, findings: o.findings });
    case "skipped":
      return st.dim(o.reason === "merge-only" ? t.t("review.mergeOnly", { repo, number }) : t.t("review.alreadyOnHost", { repo, number }));
    case "stale":
      return st.yellow(t.t("review.stale", { id: o.reviewId }));
    case "harness":
      return st.red(pickErrorText(c, o.error));
    case "failed":
      return st.red(t.t("review.failed", { repo, number, error: o.error.split("\n")[0]!.slice(0, 300) }));
    case "dry-run":
      return "";
  }
}

export interface ReviewArgs {
  post: boolean;
  dryRun: boolean;
  force: boolean;
}

export async function reviewOne(c: Ctx, repoArg: string | undefined, numberArg: string | undefined, a: ReviewArgs): Promise<number> {
  const { t } = c;
  if (!repoArg || !numberArg) return (c.err(t.t("error.usage", { usage: "crewreview review <repo> <number> [--post | --dry-run]" })), 2);
  const number = Number(numberArg.replace(/^[#!]/, ""));
  if (!Number.isInteger(number) || number <= 0) return (c.err(t.t("error.badNumber", { value: numberArg })), 2);
  const repo = await findRepo(c, repoArg);
  if (typeof repo === "string") return (c.err(repo), 2);
  const target = await connect(repo, c.version);
  if ("error" in target) return (c.err(noTokenText(c, repo)), 2);
  const d = deps(c);
  try {
    const mode = a.dryRun ? "dry-run" : a.post ? "auto" : "inbox";
    const o = await reviewPullRequest(d, target, number, mode, { force: a.force || a.dryRun });
    c.err();
    if (o.kind === "dry-run") {
      c.out(renderTerminal(o.report, t, c.style, t.t("pr.title", { repo: repo.id, number })));
      return 0;
    }
    const row = "reviewId" in o && o.reviewId !== undefined ? d.store.get(o.reviewId) : undefined;
    if (row?.jobDir && (o.kind === "pending" || o.kind === "posted")) {
      const report = JSON.parse(await Bun.file(`${row.jobDir}/report.json`).text());
      c.out(renderTerminal(report, t, c.style, t.t("pr.title", { repo: repo.id, number })));
      c.out();
    }
    c.out(outcomeText(c, repo.id, number, o));
    return o.kind === "failed" || o.kind === "harness" ? 1 : 0;
  } catch (e) {
    if (e instanceof HostError) return (c.err(t.t("error.host", { message: e.message })), 1);
    throw e;
  } finally {
    d.close();
  }
}

function logEvent(c: Ctx, e: DaemonEvent): void {
  const { t, style: st } = c;
  const time = st.dim(new Date().toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" }));
  if (e.type === "repo-error") c.err(`${time} ${st.red(`${e.repo}: ${e.code === "no-token" ? t.t("error.noToken", { host: e.repo, cli: "gh/glab", env: "GH_TOKEN/GITLAB_TOKEN" }) : t.t("error.host", { message: e.error })}`)}`);
  else if (e.type === "skip") c.err(`${time} ${st.dim(t.t("review.skipped", { repo: e.repo, number: e.number, reason: t.t(`skip.${e.reason}`) }))}`);
  else if (e.type === "start") c.err(`${time} ${t.t("review.started", { repo: e.repo, number: e.number, title: e.title, sha: e.sha.slice(0, 7) })}`);
  else if (e.type === "outcome") c.err(`${time} ${outcomeText(c, e.repo, e.number, e.outcome)}`);
  else if (e.type === "cycle") c.err(`${time} ${st.dim(t.t("run.cycle", { repos: t.tp("run.repoCount", e.repos), reviewed: e.reviewed, waiting: e.waiting }))}`);
}

/** `once`: one pass. `run`: keep going until Ctrl+C, finishing the review in progress. */
export async function watch(c: Ctx, loop: boolean): Promise<number> {
  const { t } = c;
  const repos = await loadRepos(reposFile(c.dirs));
  if (repos.filter((r) => r.review.mode !== "off").length === 0) return (c.out(t.t("repo.none")), 0);
  let release: () => Promise<void>;
  try {
    release = await acquireLock(c.dirs.state);
  } catch (e) {
    if (e instanceof LockedError) return (c.err(t.t("error.locked", { pid: e.pid })), 2);
    throw e;
  }
  const stop = new AbortController();
  const onSignal = () => {
    if (stop.signal.aborted) process.exit(130);
    c.err(t.t("run.stopping"));
    stop.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const d = deps(c, stop.signal, true);
  try {
    if (loop) c.err(t.t("run.started", { count: repos.filter((r) => r.review.mode !== "off").length }));
    do {
      // Re-read the list each pass: `repo add` or the dashboard may have changed it.
      const current = await loadRepos(reposFile(c.dirs));
      await runCycle(d, current, (e) => logEvent(c, e));
      if (!loop || stop.signal.aborted) break;
      const wait = nextInterval(c.config);
      c.err(c.errStyle.dim(t.t("run.next", { minutes: Math.round(wait / 60_000) })));
      await sleep(wait, stop.signal);
    } while (!stop.signal.aborted);
    return 0;
  } finally {
    d.close();
    await release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
