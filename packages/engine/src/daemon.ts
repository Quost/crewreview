import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RULES, reviewEligibility, type PullRequest, type ReviewRules, type SkipReason } from "@crewreview/core";
import { createHost, HostError, hostTransport, reposWithOpenPullRequests, resolveToken, type HostAdapter } from "@crewreview/hosts";
import { posterFor } from "./account.ts";
import type { Config } from "./config.ts";
import { attendPullRequest, type AttendDeps, type AttendOutcome } from "./attend.ts";
import { reviewPullRequest, type PrDeps, type PrOutcome, type PrTarget } from "./pr.ts";
import { expandOrgs, isOrg, type LinkedRepo } from "./repos.ts";

export type DaemonEvent =
  | { type: "repo-error"; repo: string; error: string; code?: "no-token" }
  | { type: "skip"; repo: string; number: number; reason: SkipReason }
  | { type: "start"; repo: string; number: number; title: string; sha: string }
  | { type: "outcome"; repo: string; number: number; outcome: PrOutcome }
  | { type: "attend-start"; repo: string; number: number; title: string }
  | { type: "attend-outcome"; repo: string; number: number; outcome: AttendOutcome }
  | { type: "cycle"; repos: number; reviewed: number; waiting: number }
  | { type: "update"; version: string; installed: boolean; error?: string };

export function rulesFor(repo: LinkedRepo, config: Config): ReviewRules {
  return {
    ...DEFAULT_RULES,
    authors: repo.review.authors,
    skipLabels: repo.review.skipLabels,
    baseBranches: repo.review.baseBranches,
    reviewDrafts: repo.review.reviewDrafts,
    reviewBots: repo.review.reviewBots,
    settleMs: config.review.settle,
    ciMaxWaitMs: config.review.ciMaxWait,
    maxFailures: config.review.maxFailures,
  };
}

/** Connect to a linked repository's host with a token found on this machine. */
export async function connect(repo: LinkedRepo, version: string): Promise<PrTarget | { error: "no-token" }> {
  const tk = await resolveToken(repo.ref);
  if (!tk) return { error: "no-token" };
  const host: HostAdapter = createHost(repo.ref, hostTransport(repo.ref, tk.token, `crewreview/${version}`));
  return { repo, host, token: tk.token, poster: await posterFor(repo, version) };
}

class NoToken extends Error {}

/** The repositories of an organization link with open pull requests, read with a token found on this machine. */
export async function openInOrg(org: LinkedRepo, version: string): Promise<string[]> {
  const tk = await resolveToken(org.ref);
  if (!tk) throw new NoToken();
  return reposWithOpenPullRequests(org.ref, hostTransport(org.ref, tk.token, `crewreview/${version}`));
}

interface Due {
  target: PrTarget;
  pr: PullRequest;
  firstSeen: number;
}

/** One pass over every linked repository: find what's due, review the oldest first, up to the cycle limit. */
export async function runCycle(
  d: PrDeps,
  links: readonly LinkedRepo[],
  log: (e: DaemonEvent) => void,
  now = () => Date.now(),
  /** How to reach each repository's host (tests swap in an in-memory one). */
  connectTo: (repo: LinkedRepo) => Promise<PrTarget | { error: "no-token" }> = (r) => connect(r, d.version),
  /** Which repositories of an organization link have open pull requests (tests swap this too). */
  listOrg: (org: LinkedRepo) => Promise<string[]> = (o) => openInOrg(o, d.version),
): Promise<{ reviewed: number; waiting: number }> {
  // Organizations become their repositories with open pull requests, found with one search each. A paused
  // organization isn't searched; a paused repository stays paused even inside an active organization.
  const expanded = await expandOrgs(
    links.filter((l) => !(isOrg(l) && l.paused)),
    listOrg,
    (org, e) =>
      log(e instanceof NoToken ? { type: "repo-error", repo: org.id, error: "no-token", code: "no-token" } : { type: "repo-error", repo: org.id, error: e instanceof HostError ? e.message : String(e) }),
  );
  const repos = expanded.filter((r) => !r.paused);
  const due: Due[] = [];
  const targets = new Map<string, PrTarget | { error: "no-token" }>();
  const reach = async (repo: LinkedRepo) => {
    if (!targets.has(repo.id)) targets.set(repo.id, await connectTo(repo));
    return targets.get(repo.id)!;
  };

  // Answer reviews on your own pull requests first: people are waiting on those.
  let attended = 0;
  for (const repo of repos.filter((r) => r.attend.mode !== "off")) {
    const target = await reach(repo);
    if ("error" in target) {
      log({ type: "repo-error", repo: repo.id, error: "no-token", code: "no-token" });
      continue;
    }
    try {
      const me = (await target.host.whoami()).toLowerCase();
      for (const pr of await target.host.listOpenPullRequests()) {
        if (attended >= d.config.attend.maxPerCycle || d.signal?.aborted) break;
        if (pr.author.toLowerCase() !== me || pr.draft) continue;
        const job = { repo: repo.id, number: pr.number, title: pr.title, kind: "attend" as const };
        const outcome = await attendPullRequest({ ...(d as AttendDeps), onEvent: (e) => d.onJobEvent?.(job, e) ?? d.onEvent?.(e) }, target, pr.number, repo.attend.mode === "auto" ? "auto" : "inbox");
        if (outcome.kind === "nothing" || (outcome.kind === "waiting" && outcome.reason === "not-yours")) continue;
        log({ type: "attend-outcome", repo: repo.id, number: pr.number, outcome });
        if (outcome.kind !== "waiting") attended++;
        if (outcome.kind === "harness") break;
      }
    } catch (err) {
      log({ type: "repo-error", repo: repo.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const active = repos.filter((r) => r.review.mode !== "off");
  for (const repo of active) {
    const target = await reach(repo);
    if ("error" in target) {
      log({ type: "repo-error", repo: repo.id, error: "no-token", code: "no-token" });
      continue;
    }
    try {
      const me = await target.host.whoami();
      const rules = rulesFor(repo, d.config);
      for (const pr of await target.host.listOpenPullRequests()) {
        // A head the crew sees for the first time dates from the host's last update, not from now: a repository
        // linked a moment ago has pull requests pushed days ago, which don't need to settle.
        const firstSeen = d.store.firstSeen(repo.id, pr.number, pr.headSha, Math.min(now(), Date.parse(pr.updatedAt) || now()));
        const input = {
          pr,
          me,
          rules,
          reviewedSha: d.store.lastDone(repo.id, pr.number)?.headSha,
          failuresOnHead: d.store.failures(repo.id, pr.number, pr.headSha),
          firstSeenAt: firstSeen,
          now: now(),
          ci: undefined,
        };
        let e = reviewEligibility(input);
        // Only ask for CI when everything else says yes: it costs a request per pull request.
        if (e.eligible && rules.ciMaxWaitMs > 0) e = reviewEligibility({ ...input, ci: (await target.host.getChecks(pr)).state });
        if (!e.eligible) {
          if (e.reason !== "already-reviewed" && e.reason !== "own" && e.reason !== "not-own") log({ type: "skip", repo: repo.id, number: pr.number, reason: e.reason });
          continue;
        }
        due.push({ target, pr, firstSeen });
      }
    } catch (err) {
      log({ type: "repo-error", repo: repo.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  due.sort((a, b) => a.firstSeen - b.firstSeen);
  let reviewed = 0;
  for (const item of due.slice(0, d.config.schedule.maxReviewsPerCycle)) {
    if (d.signal?.aborted) break;
    log({ type: "start", repo: item.target.repo.id, number: item.pr.number, title: item.pr.title, sha: item.pr.headSha });
    const mode = item.target.repo.review.mode === "auto" ? "auto" : "inbox";
    const job = { repo: item.target.repo.id, number: item.pr.number, title: item.pr.title, kind: "review" as const };
    const outcome = await reviewPullRequest({ ...d, onEvent: (e) => d.onJobEvent?.(job, e) ?? d.onEvent?.(e) }, item.target, item.pr.number, mode);
    log({ type: "outcome", repo: item.target.repo.id, number: item.pr.number, outcome });
    if (outcome.kind === "harness") break; // no reviewer available: no point trying the rest
    reviewed++;
  }
  const waiting = Math.max(0, due.length - reviewed);
  log({ type: "cycle", repos: new Set([...active, ...repos.filter((r) => r.attend.mode !== "off")].map((r) => r.id)).size, reviewed, waiting });
  return { reviewed, waiting };
}

/** Peak hours on weekdays get the short interval; nights and weekends the long one. */
export function nextInterval(config: Config, at = new Date()): number {
  const [from, to] = config.schedule.peakHours.split("-").map(Number) as [number, number];
  const day = at.getDay();
  const hour = at.getHours();
  const peak = day >= 1 && day <= 5 && (from <= to ? hour >= from && hour < to : hour >= from || hour < to);
  return peak ? config.schedule.interval : config.schedule.offHoursInterval;
}

export class LockedError extends Error {
  constructor(readonly pid: number) {
    super(`another crewreview is running (pid ${pid})`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One daemon per machine: a pid file in the state folder, taken over when its process is gone. */
export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  const file = join(stateDir, "daemon.pid");
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pid && pid !== process.pid && alive(pid)) throw new LockedError(pid);
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(file, String(process.pid));
  return async () => {
    try {
      if (readFileSync(file, "utf8").trim() === String(process.pid)) await rm(file, { force: true });
    } catch {}
  };
}

/** Sleep that wakes up early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
