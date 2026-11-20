import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Harness, HarnessEvent } from "@crewreview/harness";
import type { Translator } from "@crewreview/i18n";
import { discardAttend, publishAttend, type AttendDeps, type AttendOutcome, type AttendPayload } from "./attend.ts";
import type { Config } from "./config.ts";
import type { ConformanceStore } from "./conformance-store.ts";
import { connect, nextInterval, runCycle, sleep, type DaemonEvent } from "./daemon.ts";
import { signInOf } from "./harnesses.ts";
import { prepareLink } from "./link.ts";
import type { AppDirs } from "./paths.ts";
import { postReview, type JobRef, type PrOutcome } from "./pr.ts";
import { findLinked, loadRepos, newRepoEntry, reposFile, saveRepos, type LinkedRepo, type RepoEntry, type ReviewMode } from "./repos.ts";
import type { ReviewEvent, ReviewReport } from "./review.ts";
import type { Store } from "./state.ts";

/** One agent working right now, as the live board shows it. */
export interface LiveAgent {
  id: string;
  job: JobRef;
  role: string;
  harness: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "failed";
  lastTool?: string;
  tools: number;
  detail?: string;
}

export interface LogEntry {
  at: number;
  event: DaemonEvent;
}

export type CrewEvent =
  | { type: "agents"; agents: LiveAgent[] }
  | { type: "log"; entry: LogEntry }
  | { type: "status"; status: CrewStatus }
  | { type: "changed"; what: "inbox" | "repos" | "history" };

export interface CrewStatus {
  version: string;
  pid: number;
  startedAt: number;
  cycleRunning: boolean;
  lastCycleAt?: number;
  nextCycleAt?: number;
  inbox: number;
}

export interface CrewOptions {
  dirs: AppDirs;
  config: Config;
  version: string;
  ui: Translator;
  store: Store;
  conformance: ConformanceStore;
  registry: Map<string, Harness>;
  signing?: AttendDeps["signing"];
  configPath?: string;
  /** Checks for a newer release; returns its version, installs it when asked. Wired by the CLI. */
  updater?: { check(): Promise<string | undefined>; install(): Promise<void> };
}

const KEEP_FINISHED_MS = 60_000;
const LOG_SIZE = 200;

/** The running crew: the loop, what its agents are doing, and the actions the dashboard can take. */
export class CrewDaemon {
  readonly startedAt = Date.now();
  private agents = new Map<string, LiveAgent>();
  private log: LogEntry[] = [];
  private listeners = new Set<(e: CrewEvent) => void>();
  private cycleRunning = false;
  private lastCycleAt?: number;
  private nextCycleAt?: number;
  private wakeUp = new AbortController();

  constructor(readonly o: CrewOptions) {}

  subscribe(fn: (e: CrewEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: CrewEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {}
    }
  }

  status(): CrewStatus {
    return {
      version: this.o.version,
      pid: process.pid,
      startedAt: this.startedAt,
      cycleRunning: this.cycleRunning,
      lastCycleAt: this.lastCycleAt,
      nextCycleAt: this.nextCycleAt,
      inbox: this.o.store.inbox().length + this.o.store.attendInbox().length,
    };
  }

  liveAgents(): LiveAgent[] {
    const now = Date.now();
    for (const [k, a] of this.agents) if (a.endedAt && now - a.endedAt > KEEP_FINISHED_MS) this.agents.delete(k);
    return [...this.agents.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  recentLog(): LogEntry[] {
    return [...this.log];
  }

  private record(event: DaemonEvent): void {
    const entry = { at: Date.now(), event };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    this.emit({ type: "log", entry });
    if (event.type === "outcome" || event.type === "attend-outcome") {
      this.emit({ type: "changed", what: "inbox" });
      this.emit({ type: "changed", what: "history" });
    }
  }

  /** Turn pipeline events into the live board. */
  private onJobEvent(job: JobRef, e: ReviewEvent): void {
    const key = (role: string) => `${job.repo}#${job.number}:${role}`;
    const start = (role: string, harness: string) => {
      this.agents.set(key(role), { id: key(role), job, role, harness, startedAt: Date.now(), status: "running", tools: 0 });
    };
    const end = (role: string, ok: boolean, detail?: string) => {
      const a = this.agents.get(key(role));
      if (a) Object.assign(a, { status: ok ? "ok" : "failed", endedAt: Date.now(), detail });
    };
    if (e.type === "lens-start") start(e.lens, e.harness);
    else if (e.type === "lens-done") end(e.result.lens, e.result.status === "ok", e.result.status === "ok" ? `${e.result.findings.length}` : e.result.error);
    else if (e.type === "verifier-start") start("verifier", e.harness);
    else if (e.type === "verifier-done") end("verifier", e.ok, e.ok ? `-${e.dropped}` : e.error);
    else if (e.type === "attendant-start") start("attendant", e.harness);
    else if (e.type === "attendant-done") end("attendant", e.ok, e.error);
    else if (e.type === "agent") {
      const a = this.agents.get(key(e.role));
      if (a && (e.event as HarnessEvent).type === "tool") {
        a.tools++;
        a.lastTool = e.event.text.slice(0, 160);
      } else return; // text chunks don't change the board
    } else return;
    this.emit({ type: "agents", agents: this.liveAgents() });
  }

  private deps(signal?: AbortSignal): AttendDeps {
    const { dirs, config, store, conformance, registry, version, ui, signing } = this.o;
    return { dirs, config, store, conformance, registry, version, ui, signing, signal, onJobEvent: (job, e) => this.onJobEvent(job, e) };
  }

  /** Run one cycle now (or right after the current one). */
  wake(): void {
    this.wakeUp.abort();
  }

  async cycle(signal?: AbortSignal): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    this.emit({ type: "status", status: this.status() });
    try {
      const repos = await loadRepos(reposFile(this.o.dirs));
      await runCycle(this.deps(signal), repos, (e) => this.record(e));
    } catch (e) {
      this.record({ type: "repo-error", repo: "*", error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.cycleRunning = false;
      this.lastCycleAt = Date.now();
      this.emit({ type: "status", status: this.status() });
    }
  }

  private lastUpdateCheck = 0;

  /** Once a day: tell about a new release, or install it (then the caller restarts). Returns true to restart. */
  private async maybeUpdate(): Promise<boolean> {
    const u = this.o.updater;
    if (!u || !this.o.config.updates.check || Date.now() - this.lastUpdateCheck < 24 * 3_600_000) return false;
    this.lastUpdateCheck = Date.now();
    try {
      const version = await u.check();
      if (!version) return false;
      if (!this.o.config.updates.auto) {
        this.record({ type: "update", version, installed: false });
        return false;
      }
      await u.install();
      this.record({ type: "update", version, installed: true });
      return true;
    } catch (e) {
      this.record({ type: "update", version: "?", installed: false, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** Cycle, sleep, repeat until the signal aborts. `wake()` cuts the sleep short. Resolves "restart" after an update. */
  async loop(signal: AbortSignal): Promise<"stopped" | "restart"> {
    while (!signal.aborted) {
      await this.cycle(signal);
      if (signal.aborted) break;
      if (await this.maybeUpdate()) return "restart";
      const wait = nextInterval(this.o.config);
      this.nextCycleAt = Date.now() + wait;
      this.emit({ type: "status", status: this.status() });
      this.wakeUp = new AbortController();
      await sleep(wait, AbortSignal.any([signal, this.wakeUp.signal]));
      this.nextCycleAt = undefined;
    }
    return "stopped";
  }

  // ---- actions for the dashboard ----

  async repos(): Promise<LinkedRepo[]> {
    return loadRepos(reposFile(this.o.dirs));
  }

  async updateRepo(id: string, patch: { review?: Partial<Pick<RepoEntry["review"], "mode" | "authors">>; attend?: Partial<Pick<RepoEntry["attend"], "mode" | "fromCrew">> }): Promise<LinkedRepo | undefined> {
    const repos = await this.repos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    const entries = repos.map(({ ref: _ref, ...e }) => e);
    const e = entries[idx]!;
    const merged = newRepoEntry(repos[idx]!.ref, { ...e, review: { ...e.review, ...patch.review }, attend: { ...e.attend, ...patch.attend } });
    entries[idx] = merged;
    await saveRepos(reposFile(this.o.dirs), entries);
    this.emit({ type: "changed", what: "repos" });
    return { ...merged, ref: repos[idx]!.ref };
  }

  /** Link a repository, or a whole organization or group. */
  async addRepo(url: string, mode: ReviewMode = "inbox"): Promise<{ repo: LinkedRepo; user: string; openRepos?: number } | { error: "url" | "exists" | "no-token" | "host"; message?: string }> {
    const repos = await this.repos();
    const p = await prepareLink(url, repos, { version: this.o.version, overrides: { review: { mode } } });
    if ("error" in p) return { error: p.error, message: p.message };
    await saveRepos(reposFile(this.o.dirs), [...repos.map(({ ref: _r, ...x }) => x), p.entry]);
    this.emit({ type: "changed", what: "repos" });
    return { repo: { ...p.entry, ref: p.ref }, user: p.user, openRepos: p.openRepos };
  }

  async removeRepo(id: string): Promise<boolean> {
    const repos = await this.repos();
    if (!repos.some((r) => r.id === id)) return false;
    await saveRepos(reposFile(this.o.dirs), repos.filter((r) => r.id !== id).map(({ ref: _r, ...x }) => x));
    this.emit({ type: "changed", what: "repos" });
    return true;
  }

  inbox() {
    const reviews = this.o.store.inbox().map((r) => ({ id: `r${r.id}`, kind: "review" as const, repo: r.repo, number: r.number, title: r.title, url: r.url, createdAt: r.createdAt, event: r.event, findings: r.findings }));
    const fixes = this.o.store.attendInbox().map((f) => {
      const p = f.payload ? (JSON.parse(f.payload) as AttendPayload) : undefined;
      return {
        id: `f${f.id}`,
        kind: "fix" as const,
        repo: f.repo,
        number: f.number,
        title: f.title,
        url: f.url,
        createdAt: f.createdAt,
        fixed: p?.decisions.filter((x) => x.action === "fixed").length ?? 0,
        replies: p?.decisions.filter((x) => x.action !== "needs-human" && x.reply).length ?? 0,
        forced: p?.forcedInbox,
      };
    });
    return [...reviews, ...fixes].sort((a, b) => a.createdAt - b.createdAt);
  }

  async inboxItem(id: string): Promise<{ kind: "review"; row: unknown; report: ReviewReport } | { kind: "fix"; row: unknown; payload: AttendPayload; diff: string } | undefined> {
    const n = Number(id.slice(1));
    if (id.startsWith("r")) {
      const row = this.o.store.get(n);
      if (!row?.jobDir) return undefined;
      return { kind: "review", row, report: JSON.parse(await readFile(join(row.jobDir, "report.json"), "utf8")) };
    }
    if (id.startsWith("f")) {
      const row = this.o.store.getAttend(n);
      if (!row?.payload) return undefined;
      const diff = row.jobDir ? await readFile(join(row.jobDir, "diff.patch"), "utf8").catch(() => "") : "";
      return { kind: "fix", row, payload: JSON.parse(row.payload), diff };
    }
    return undefined;
  }

  async approve(id: string): Promise<PrOutcome | AttendOutcome | { kind: "missing" } | { kind: "no-token" }> {
    const n = Number(id.slice(1));
    const row = id.startsWith("r") ? this.o.store.get(n) : this.o.store.getAttend(n);
    if (!row || row.status !== "pending") return { kind: "missing" };
    const repo = findLinked(await this.repos(), row.repo, row.url);
    if (!repo) return { kind: "missing" };
    const target = await connect(repo, this.o.version);
    if ("error" in target) return { kind: "no-token" };
    const result = id.startsWith("r") ? await postReview(this.deps(), target, n) : await publishAttend(this.deps(), target, n);
    this.emit({ type: "changed", what: "inbox" });
    this.emit({ type: "changed", what: "history" });
    this.emit({ type: "status", status: this.status() });
    return result;
  }

  async discard(id: string): Promise<boolean> {
    const n = Number(id.slice(1));
    let ok = false;
    if (id.startsWith("r")) {
      const row = this.o.store.get(n);
      if (row?.status === "pending") {
        this.o.store.update(n, { status: "discarded" });
        ok = true;
      }
    } else if (id.startsWith("f")) ok = await discardAttend(this.deps(), n);
    if (ok) {
      this.emit({ type: "changed", what: "inbox" });
      this.emit({ type: "status", status: this.status() });
    }
    return ok;
  }

  history(limit = 50) {
    const reviews = this.o.store.recent(limit).map((r) => ({ id: `r${r.id}`, kind: "review" as const, repo: r.repo, number: r.number, title: r.title, url: r.postedUrl ?? r.url, status: r.status, event: r.event, findings: r.findings, note: r.note, error: r.error, at: r.updatedAt }));
    const attends = this.o.store.recentAttends(limit).map((a) => ({ id: `f${a.id}`, kind: "fix" as const, repo: a.repo, number: a.number, title: a.title, url: a.url, status: a.status, commit: a.commitSha, note: a.note, error: a.error, at: a.updatedAt }));
    return [...reviews, ...attends].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async harnesses() {
    const out = [];
    for (const h of this.o.registry.values()) {
      const det = await h.detect();
      const conf = det.installed ? await this.o.conformance.get(h.id, det.version) : undefined;
      const signIn = det.installed ? await signInOf(h) : undefined;
      out.push({ id: h.id, name: h.name, kind: h.kind, installed: det.installed, version: det.version, capabilities: h.capabilities, conformance: conf, signIn, loginCommand: h.loginCommand });
    }
    return out;
  }

  /** Tokens and cost of today's reviews, from their reports. */
  async usageToday(): Promise<{ reviews: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = this.o.store.recent(500).filter((r) => r.createdAt >= start.getTime() && r.jobDir);
    const total = { reviews: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const r of rows) {
      try {
        const rep = JSON.parse(await readFile(join(r.jobDir!, "report.json"), "utf8")) as ReviewReport;
        total.reviews++;
        total.inputTokens += rep.usage.inputTokens ?? 0;
        total.outputTokens += rep.usage.outputTokens ?? 0;
        total.costUsd += rep.usage.costUsd ?? 0;
      } catch {}
    }
    return total;
  }

  limits() {
    const c = this.o.config;
    return { configPath: this.o.configPath, limits: c.limits, schedule: c.schedule, review: { settle: c.review.settle, ciMaxWait: c.review.ciMaxWait, maxFailures: c.review.maxFailures, lenses: c.review.lenses, policy: c.review.policy }, attend: c.attend, harness: { default: c.harness.default, verifier: c.harness.verifier } };
  }
}
