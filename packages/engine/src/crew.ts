import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveHarness, runConformance, type Harness, type HarnessEvent } from "@crewreview/harness";
import { acceptInvitations, createHost, githubUser, hostTransport, inviteCollaborator, repoRef, resolveAccountToken, resolveToken } from "@crewreview/hosts";
import type { Translator } from "@crewreview/i18n";
import { discardAttend, publishAttend, type AttendDeps, type AttendOutcome, type AttendPayload } from "./attend.ts";
import type { Config } from "./config.ts";
import type { ConformanceStore } from "./conformance-store.ts";
import { hostAccess, linkFromUrl, type HostAccess } from "./access.ts";
import { checkAccount, type AccountProblem } from "./account.ts";
import { editConfig, type EditableKey } from "./config-edit.ts";
import { AccountSignIn, type SignInState } from "./account-setup.ts";
import { keepAwake, type KeepAwake } from "./awake.ts";
import { connect, nextInterval, runCycle, sleep, type DaemonEvent } from "./daemon.ts";
import { reviewable, signInOf } from "./harnesses.ts";
import { prepareLink } from "./link.ts";
import { configFile, type AppDirs } from "./paths.ts";
import { postReview, type JobRef, type PrOutcome } from "./pr.ts";
import { previewLink, type Preview } from "./preview.ts";
import { QuotaBook } from "./quota.ts";
import { findLinked, loadRepos, newRepoEntry, reposFile, saveRepos, type LinkedRepo, type RepoEntry, type ReviewMode } from "./repos.ts";
import type { ReviewEvent, ReviewReport } from "./review.ts";
import type { Store } from "./state.ts";

/** A GitHub login: letters, digits and single hyphens, never an option. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Milliseconds as the shortest way to write them in config.toml: 3m, 45s, 1h, 1500ms. */
export function durationText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

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
  | { type: "changed"; what: "inbox" | "repos" | "history" | "settings" | "harnesses" };

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
  /** Holds the computer awake from the first agent of a cycle to its end (`schedule.keepAwake`). */
  private awake?: KeepAwake;
  private book?: QuotaBook;
  /** Paused harnesses and today's agent runs, shared with the CLI through a file. */
  get quota(): QuotaBook {
    return (this.book ??= QuotaBook.in(this.o.dirs.state));
  }
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
      (this.awake ??= keepAwake({ enabled: this.o.config.schedule.keepAwake })).on();
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
    return { dirs, config, store, conformance, registry, version, ui, signing, signal, quota: this.quota, onJobEvent: (job, e) => this.onJobEvent(job, e) };
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
      this.awake?.off();
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

  async updateRepo(
    id: string,
    patch: { review?: Partial<Pick<RepoEntry["review"], "mode" | "authors">> & { account?: string | null }; attend?: Partial<Pick<RepoEntry["attend"], "mode" | "fromCrew" | "conflicts" | "ci">>; paused?: boolean },
  ): Promise<LinkedRepo | undefined> {
    const repos = await this.repos();
    const idx = repos.findIndex((r) => r.id === id);
    if (idx === -1) return undefined;
    const entries = repos.map(({ ref: _ref, ...e }) => e);
    const e = entries[idx]!;
    const { account, ...rest } = patch.review ?? {};
    const review = { ...e.review, ...rest };
    if (account === null) delete review.account;
    else if (account !== undefined) review.account = account;
    const paused = patch.paused === undefined ? e.paused : patch.paused || undefined;
    const merged = newRepoEntry(repos[idx]!.ref, { ...e, paused, review, attend: { ...e.attend, ...patch.attend } });
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

  // ---- settings the dashboard changes (config.toml) and the desktop app's own (open at login) ----

  /** Set by `run --desktop`: what the app said about itself, and how to ask it for a change. */
  desktop?: { autostart?: boolean; request: (msg: Record<string, unknown>) => void };

  /** The app told the crew something about itself (over stdin). */
  desktopSays(msg: { autostart?: unknown }): void {
    if (!this.desktop || typeof msg.autostart !== "boolean") return;
    this.desktop.autostart = msg.autostart;
    this.emit({ type: "changed", what: "settings" });
  }

  /** Every setting the dashboard can change, as it would write it, and the app's own when it runs inside it. */
  settings() {
    const c = this.o.config;
    const values: Record<EditableKey, unknown> = {
      "schedule.interval": durationText(c.schedule.interval),
      "schedule.offHoursInterval": durationText(c.schedule.offHoursInterval),
      "schedule.peakHours": c.schedule.peakHours,
      "schedule.maxReviewsPerCycle": c.schedule.maxReviewsPerCycle,
      "schedule.keepAwake": c.schedule.keepAwake,
      "limits.maxConcurrentAgents": c.limits.maxConcurrentAgents ?? null,
      "limits.agentTimeout": durationText(c.limits.agentTimeout),
      "limits.stallTimeout": durationText(c.limits.stallTimeout),
      "limits.maxDiffLines": c.limits.maxDiffLines,
      "limits.dailyRuns": c.limits.dailyRuns ?? null,
      "review.settle": durationText(c.review.settle),
      "review.ciMaxWait": durationText(c.review.ciMaxWait),
      "review.policy.allowApprove": c.review.policy.allowApprove,
      "attend.quiet": durationText(c.attend.quiet),
      "attend.maxPerCycle": c.attend.maxPerCycle,
      "harness.default": c.harness.default,
      "harness.verifier": c.harness.verifier ?? null,
      "updates.check": c.updates.check,
    };
    return { values, harnesses: ["auto", ...this.o.registry.keys()], configPath: this.o.configPath, desktop: this.desktop ? { autostart: this.desktop.autostart ?? null } : null };
  }

  /**
   * Change settings: config.toml line by line, then the crew uses them at once (the next check, the next agent).
   * `autostart` goes to the desktop app, which answers with its new state.
   */
  async updateSettings(patch: { values?: Record<string, unknown>; autostart?: unknown }): Promise<{ ok: true } | { error: string; key?: string }> {
    if (patch.autostart !== undefined) {
      if (typeof patch.autostart !== "boolean") return { error: "autostart: on or off", key: "autostart" };
      if (!this.desktop) return { error: "not-desktop", key: "autostart" };
      this.desktop.request({ autostart: patch.autostart });
    }
    if (patch.values && Object.keys(patch.values).length) {
      const r = await editConfig(this.o.configPath ?? configFile(this.o.dirs), patch.values);
      if ("error" in r) return r;
      this.o.config = r.config;
      this.emit({ type: "changed", what: "settings" });
      this.emit({ type: "status", status: this.status() });
    }
    return { ok: true };
  }

  /** Whether an account can post a repository's reviews, and who it is. */
  async checkAccount(id: string, account: string): Promise<{ user: string } | AccountProblem | undefined> {
    const link = (await this.repos()).find((r) => r.id === id);
    return link ? checkAccount(link.ref, account, this.o.version) : undefined;
  }

  // ---- a second account to post reviews as (the guided setup in the dashboard) ----

  private signIn?: AccountSignIn;

  /** The GitHub repositories these ids name, all on one host. */
  private async githubLinks(ids: readonly string[]): Promise<LinkedRepo[]> {
    const links = (await this.repos()).filter((r) => ids.includes(r.id) && r.ref.kind === "github" && r.scope !== "org");
    const host = links[0]?.ref.host;
    return links.filter((r) => r.ref.host === host);
  }

  /** A transport with your own token for a GitHub host. */
  private async yourTransport(host: string) {
    const ref = repoRef("github", host, "crewreview");
    const tk = await resolveToken(ref);
    return tk ? { ref, t: hostTransport(ref, tk.token, `crewreview/${this.o.version}`) } : undefined;
  }

  /** Whether a GitHub login exists. */
  async accountUser(login: string, host = "github.com"): Promise<{ login: string; type: string } | { error: "no-token" | "not-found" | "bad-name" | "same-account"; name?: string }> {
    if (!LOGIN.test(login)) return { error: "bad-name" };
    const you = await this.yourTransport(host);
    if (!you) return { error: "no-token" };
    const user = await githubUser(you.t, login);
    if (!user) return { error: "not-found" };
    // Your own account still couldn't approve your pull requests: say so now, not at the last step.
    const me = await createHost(you.ref, you.t).whoami().catch(() => undefined);
    return me?.toLowerCase() === user.login.toLowerCase() ? { error: "same-account", name: user.login } : user;
  }

  /** Invite the account to these repositories with write access, with your token. */
  async accountInvite(login: string, ids: readonly string[]): Promise<{ id: string; result?: "invited" | "already"; error?: string }[]> {
    if (!LOGIN.test(login)) return [];
    const links = await this.githubLinks(ids);
    const you = links[0] && (await this.yourTransport(links[0].ref.host));
    return Promise.all(
      links.map(async (r) => {
        if (!you) return { id: r.id, error: "no-token" };
        try {
          return { id: r.id, result: await inviteCollaborator(you.t, r.ref.slug, login) };
        } catch (e) {
          return { id: r.id, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }

  /** Sign the account in to gh: returns the one-time code to show, then `signInStatus` follows it. */
  async accountSignIn(login: string, host = "github.com"): Promise<SignInState> {
    if (!LOGIN.test(login)) return { state: "failed", login, error: "failed", detail: "not a login" };
    const ref = repoRef("github", host, "crewreview");
    this.signIn?.cancel();
    this.signIn = new AccountSignIn(ref, { whoami: (token) => createHost(ref, hostTransport(ref, token, `crewreview/${this.o.version}`)).whoami() });
    return this.signIn.start(login);
  }

  signInStatus(): SignInState {
    return this.signIn?.status() ?? { state: "idle" };
  }

  cancelSignIn(): void {
    this.signIn?.cancel();
  }

  /** With the account's own token (from gh): accept its invitations to these repositories. */
  async accountAccept(login: string, ids: readonly string[]): Promise<{ accepted: string[] } | AccountProblem | { error: "none" }> {
    const links = await this.githubLinks(ids);
    if (!links[0]) return { error: "none" };
    const tk = await resolveAccountToken(links[0].ref, login);
    if ("error" in tk) return tk;
    try {
      return { accepted: await acceptInvitations(hostTransport(links[0].ref, tk.token, `crewreview/${this.o.version}`), links.map((r) => r.ref.slug)) };
    } catch (e) {
      return { error: "host", name: login, message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
  }

  /** What the crew would do with a link right now, without doing it. */
  async previewRepo(id: string): Promise<Preview | undefined> {
    const link = (await this.repos()).find((r) => r.id === id);
    return link ? previewLink(this.deps(), link) : undefined;
  }

  /** The same, for an address that may not be linked yet: what linking it would start. */
  async previewUrl(url: string): Promise<Preview | { error: "url"; message: string }> {
    const link = linkFromUrl(url, await this.repos());
    return "error" in link ? link : previewLink(this.deps(), link);
  }

  /** Whether this machine can reach GitHub, GitLab and the linked hosts, and as whom. */
  async hosts(): Promise<HostAccess[]> {
    return hostAccess(await this.repos(), { version: this.o.version });
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
    // The one reviews use: the configured harness, or with `auto` the first installed one.
    const chosen = await resolveHarness(this.o.registry, this.o.config.harness.default);
    for (const h of this.o.registry.values()) {
      const det = await h.detect();
      const conf = det.installed ? await this.o.conformance.get(h.id, det.version) : undefined;
      const signIn = det.installed ? await signInOf(h) : undefined;
      // Whether it may review now, or first has to prove its read-only lock on this machine (ACP and custom agents).
      const review = det.installed ? await reviewable(h, this.o.conformance) : undefined;
      out.push({ id: h.id, name: h.name, kind: h.kind, installed: det.installed, version: det.version, capabilities: h.capabilities, conformance: conf, signIn, loginCommand: h.loginCommand, pausedUntil: this.quota.pausedUntil(h.id), chosen: h.id === chosen?.id, review, proving: this.proving.has(h.id) });
    }
    return out;
  }

  private proving = new Set<string>();

  /**
   * Prove a harness's locks from the dashboard, as `doctor --conformance` does: two tiny prompts on the user's plan.
   * It runs in the background; the harness list says `proving` meanwhile and shows the result after.
   */
  async prove(id: string): Promise<{ ok: true } | { error: "unknown" | "not-installed" | "not-read-only" | "busy" }> {
    const h = this.o.registry.get(id);
    if (!h) return { error: "unknown" };
    if (!(await h.detect()).installed) return { error: "not-installed" };
    if (h.capabilities.readOnly !== "enforced") return { error: "not-read-only" };
    if (this.proving.has(id)) return { error: "busy" };
    this.proving.add(id);
    this.emit({ type: "changed", what: "harnesses" });
    void (async () => {
      try {
        await this.o.conformance.put(await runConformance(h, { write: h.capabilities.write }));
      } catch {
        // A run that couldn't start leaves no result: the button stays, the next try runs again.
      } finally {
        this.proving.delete(id);
        this.emit({ type: "changed", what: "harnesses" });
      }
    })();
    return { ok: true };
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
    return { configPath: this.o.configPath, limits: c.limits, schedule: c.schedule, review: { settle: c.review.settle, ciMaxWait: c.review.ciMaxWait, maxFailures: c.review.maxFailures, lenses: c.review.lenses, policy: c.review.policy }, attend: c.attend, harness: { default: c.harness.default, verifier: c.harness.verifier, fallback: c.harness.fallback }, quota: this.quota.status() };
  }
}
