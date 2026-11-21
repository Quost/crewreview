import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyHandoff,
  extractJson,
  handoffMarkdown,
  makeMarker,
  nextAction,
  parseHandoff,
  parsePlan,
  planMarkdown,
  type Handoff,
  type TaskAction,
  type TaskState,
} from "@crewreview/core";
import type { Harness, RunResult } from "@crewreview/harness";
import { gitAuthEnv } from "@crewreview/hosts";
import { languageName, matchLocale } from "@crewreview/i18n";
import { runChecks, shorten } from "./attend.ts";
import { git, gitOk } from "./git.ts";
import { isPickError, pickReviewer, pickWriter, type PickError } from "./harnesses.ts";
import { BUILTIN_LENS_IDS, loadLenses } from "./lenses.ts";
import { ensureMirror } from "./mirror.ts";
import type { PrDeps, PrTarget } from "./pr.ts";
import { buildPrompt, planPrompt } from "./prompts.ts";
import { pickLimits } from "./quota.ts";
import { runReview } from "./review.ts";
import { fixedSeat, type SeatChoice, type SeatPicker } from "./seats.ts";
import { addWorktree, ATTEND_DIR, changedPaths, commitAll, diffStat, pushHead, removeWorktree } from "./worktree.ts";

/** A crew mode task as it's kept in tasks/<id>/state.json: the ledger's rules state plus where the work lives. */
export interface TaskRecord extends TaskState {
  /** The linked repository it works on. */
  repo: string;
  text: string;
  /** inbox: the plan and opening the pull request wait for you. auto: neither does. */
  mode: "inbox" | "auto";
  createdAt: number;
  updatedAt: number;
  base: string;
  baseSha?: string;
  branch: string;
  /** The last self-review: what it found, how much of it was blocking, and the findings themselves for the PR. */
  lastReview?: { findings: number; blocking: number; event: string; items?: { severity: string; path: string; line: number; title: string }[] };
  pr?: { number: number; url: string };
}

export type TaskEvent =
  | { type: "agent-start"; task: string; role: "plan" | "build" | "review"; seat: string; harness: string; step?: string }
  | { type: "agent-done"; task: string; role: "plan" | "build" | "review"; ok: boolean; error?: string }
  | { type: "planned"; task: string; steps: number }
  | { type: "step-done"; task: string; step: string; commit?: string }
  | { type: "checks-failed"; task: string; command: string }
  | { type: "reviewed"; task: string; findings: number; blocking: number; round: number }
  | { type: "opened"; task: string; url: string }
  | { type: "waiting"; task: string; until?: number; reason: string }
  | { type: "asks"; task: string; reason: string; step?: string }
  | { type: "failed"; task: string; error: string };

export interface TaskDeps extends PrDeps {
  signing?: "inherit" | "off";
  identity?: { name: string; email: string };
  now?: () => number;
  onTask?: (e: TaskEvent) => void;
}

/** What one call to advanceTask did, and whether the task can go on without you. */
export type TaskStepOutcome = { action: TaskAction["kind"]; more: boolean };

export function tasksDir(d: Pick<PrDeps, "dirs">): string {
  return join(d.dirs.data, "tasks");
}

const taskDir = (d: Pick<PrDeps, "dirs">, id: string) => join(tasksDir(d), id);
const workDir = (d: Pick<PrDeps, "dirs">, id: string) => join(taskDir(d, id), "work");
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
/** How a handoff says the project's checks failed, so the next turn gets the output. */
const CHECKS_FAILED = "checks failed:";

/** A readable, unique id: the day and a few words of the task. */
export function taskId(text: string, now: number, taken: (id: string) => boolean): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
  const base = `${day}-${words || "task"}`;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

export async function saveTask(d: Pick<PrDeps, "dirs">, rec: TaskRecord): Promise<void> {
  const dir = taskDir(d, rec.id);
  await mkdir(join(dir, "handoffs"), { recursive: true });
  const tmp = join(dir, "state.json.tmp");
  await writeFile(tmp, JSON.stringify(rec, null, 2));
  await rename(tmp, join(dir, "state.json"));
  await writeFile(join(dir, "task.md"), `${rec.text}\n`);
  if (rec.plan) await writeFile(join(dir, "plan.md"), planMarkdown(rec.text, rec.plan));
}

export async function loadTask(d: Pick<PrDeps, "dirs">, id: string): Promise<TaskRecord | undefined> {
  if (!TASK_ID.test(id)) return undefined;
  try {
    return JSON.parse(await readFile(join(taskDir(d, id), "state.json"), "utf8")) as TaskRecord;
  } catch {
    return undefined;
  }
}

export async function listTasks(d: Pick<PrDeps, "dirs">): Promise<TaskRecord[]> {
  const ids = existsSync(tasksDir(d)) ? await readdir(tasksDir(d)) : [];
  const out = (await Promise.all(ids.map((id) => loadTask(d, id)))).filter((t): t is TaskRecord => !!t);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function logTask(d: Pick<PrDeps, "dirs">, id: string, e: object): Promise<void> {
  const file = join(taskDir(d, id), "log.jsonl");
  await writeFile(file, `${JSON.stringify({ at: Date.now(), ...e })}\n`, { flag: "a" });
}

/** A new task on a linked repository, saved at the planning stage. The base is the repository's default branch. */
export async function createTask(d: TaskDeps, x: PrTarget, text: string, opts: { base?: string; mode?: "inbox" | "auto" } = {}): Promise<TaskRecord> {
  const now = d.now?.() ?? Date.now();
  const taken = (id: string) => existsSync(taskDir(d, id));
  const id = taskId(text, now, taken);
  const base = opts.base ?? (await x.host.defaultBranch?.()) ?? "main";
  const rec: TaskRecord = {
    id,
    stage: "planning",
    handoffs: [],
    turns: 0,
    reviewRounds: 0,
    repo: x.repo.id,
    text: text.trim(),
    mode: opts.mode ?? "inbox",
    createdAt: now,
    updatedAt: now,
    base,
    branch: `${d.config.task.branchPrefix}${id}`,
  };
  await saveTask(d, rec);
  await logTask(d, id, { type: "created", repo: rec.repo, base });
  return rec;
}

/** You approved the plan, or opening the pull request. */
export async function approveTask(d: TaskDeps, id: string): Promise<TaskRecord | undefined> {
  const rec = await loadTask(d, id);
  if (!rec || (rec.stage !== "approval" && rec.stage !== "ready")) return undefined;
  const next = { ...rec, stage: rec.stage === "approval" ? ("building" as const) : ("opening" as const), updatedAt: Date.now() };
  await saveTask(d, next);
  await logTask(d, id, { type: "approved", stage: rec.stage });
  return next;
}

export async function cancelTask(d: TaskDeps, id: string): Promise<TaskRecord | undefined> {
  const rec = await loadTask(d, id);
  if (!rec || rec.stage === "done" || rec.stage === "cancelled") return undefined;
  const next = { ...rec, stage: "cancelled" as const, updatedAt: Date.now() };
  await saveTask(d, next);
  await logTask(d, id, { type: "cancelled" });
  await dropWorkspace(d, id);
  return next;
}

/** Remove a task's checkout; its worktree belongs to the mirror git points at from inside it. */
async function dropWorkspace(d: TaskDeps, id: string): Promise<void> {
  const dir = workDir(d, id);
  if (!existsSync(dir)) return;
  const common = (await git(["rev-parse", "--git-common-dir"], dir)).stdout.trim();
  if (common) await removeWorktree(common, dir).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

/**
 * The task's checkout: a worktree of Crewreview's own mirror (never your clone), at the task's saved progress when
 * there is some, otherwise at the latest base. Its context folder holds the task, the plan, the last handoff and
 * the progress so far; it's excluded from commits.
 */
async function workspace(d: TaskDeps, x: PrTarget, rec: TaskRecord): Promise<{ mirror: string; dir: string; rec: TaskRecord }> {
  const authEnv = gitAuthEnv(x.repo.ref, x.token);
  const mirror = await ensureMirror({ dataDir: d.dirs.data, repo: x.repo.ref, authEnv, reference: x.repo.clone });
  const dir = workDir(d, rec.id);
  const progress = `refs/crewreview/task/${rec.id}`;
  if (!existsSync(join(dir, ".git"))) {
    const baseRef = `refs/crewreview/base/${rec.base}`;
    await gitOk(["fetch", "--no-tags", "--force", "--quiet", "origin", `+refs/heads/${rec.base}:${baseRef}`], mirror, authEnv);
    const baseSha = rec.baseSha ?? (await gitOk(["rev-parse", baseRef], mirror)).trim();
    const saved = (await git(["rev-parse", "--verify", "--quiet", progress], mirror)).stdout.trim();
    await addWorktree(mirror, saved || baseSha, dir);
    rec = { ...rec, baseSha };
  }
  return { mirror, dir, rec };
}

async function writeContext(dir: string, rec: TaskRecord, extra: Record<string, string> = {}): Promise<void> {
  const ctx = join(dir, ATTEND_DIR);
  await mkdir(ctx, { recursive: true });
  await writeFile(join(ctx, "task.md"), `${rec.text}\n`);
  if (rec.plan) await writeFile(join(ctx, "plan.md"), planMarkdown(rec.text, rec.plan));
  const last = rec.handoffs.at(-1);
  if (last) await writeFile(join(ctx, "handoff.md"), handoffMarkdown(last, rec.plan));
  else await rm(join(ctx, "handoff.md"), { force: true });
  const committed = rec.baseSha ? (await git(["log", "--oneline", `${rec.baseSha}..HEAD`], dir)).stdout.trim() : "";
  const stat = await diffStat(dir).catch(() => "");
  await writeFile(join(ctx, "progress.md"), [`# Progress`, "", "## Commits on the task branch", committed || "(none yet)", "", "## Uncommitted changes", stat || "(none)", ""].join("\n"));
  for (const [name, text] of Object.entries(extra)) await writeFile(join(ctx, name), text);
}

/** Who plans and who builds: the seats [roles] names, or the harness from the setup as before. */
async function seatFor(d: TaskDeps, role: "plan" | "build"): Promise<SeatPicker | PickError> {
  const routed = d.seats?.picker(role);
  if (routed) return routed;
  const limits = pickLimits(d.config, d.quota);
  const h = role === "build" ? await pickWriter(d.registry, d.config.harness.default, d.conformance, limits) : await pickReviewer(d.registry, d.config.harness.default, d.conformance, limits);
  return isPickError(h) ? h : fixedSeat(h, d.config);
}

async function runAgent(d: TaskDeps, rec: TaskRecord, role: "plan" | "build", c: SeatChoice, cwd: string, prompt: string, step?: string): Promise<RunResult> {
  d.onTask?.({ type: "agent-start", task: rec.id, role, seat: c.seat, harness: c.harness.id, ...(step ? { step } : {}) });
  const r = await c.harness
    .run({ prompt, cwd, access: role === "build" ? "write" : "read", timeoutMs: d.config.limits.agentTimeout, stallMs: d.config.limits.stallTimeout, model: c.model, effort: c.effort, signal: d.signal })
    .finally(() => c.done());
  // Each agent's own answer stays in the ledger, next to the handoff code made of it.
  const answers = join(taskDir(d, rec.id), "answers");
  await mkdir(answers, { recursive: true });
  await writeFile(join(answers, `${String(rec.handoffs.length + 1).padStart(3, "0")}-${role}-${c.seat}.txt`), r.ok ? r.text : `${r.failure}: ${r.error ?? ""}`);
  if (!r.ok && r.failure === "quota") c.limit(r.error ?? "quota");
  d.onTask?.({ type: "agent-done", task: rec.id, role, ok: r.ok, ...(r.ok ? {} : { error: `${r.failure}: ${(r.error ?? "").split("\n")[0]}` }) });
  return r;
}

const ownerOf = async (x: PrTarget) => x.host.whoami().catch(() => "the developer");
const languageFor = (d: TaskDeps) => languageName(d.config.review.commentLanguage ?? matchLocale(d.ui.locale) ?? "en");

/**
 * Take the task one action further and save it: plan, build one step, review, or open the pull request. Returns
 * what it did and whether more can happen without you (approvals, a blocker or a wait end the run).
 */
export async function advanceTask(d: TaskDeps, x: PrTarget, id: string): Promise<TaskStepOutcome> {
  let rec = await loadTask(d, id);
  if (!rec) throw new Error(`no task ${id}`);
  const now = d.now?.() ?? Date.now();
  const action = nextAction(rec, now, { maxTurns: d.config.task.maxTurns, maxReviewRounds: d.config.task.maxReviewRounds });
  const save = async (next: TaskRecord) => {
    rec = { ...next, updatedAt: d.now?.() ?? Date.now() };
    await saveTask(d, rec);
  };
  try {
    switch (action.kind) {
      case "stop":
        return { action: action.kind, more: false };
      case "await-approval":
        return { action: action.kind, more: false };
      case "wait":
        d.onTask?.({ type: "waiting", task: id, until: action.until, reason: "seat-paused" });
        return { action: action.kind, more: false };
      case "ask":
        d.onTask?.({ type: "asks", task: id, reason: action.reason, ...(action.step ? { step: action.step } : {}) });
        await logTask(d, id, { type: "asks", reason: action.reason, step: action.step });
        return { action: action.kind, more: false };
      case "plan":
        await save(await plan(d, x, rec));
        return { action: action.kind, more: rec.stage === "building" };
      case "build":
        await save(await build(d, x, rec, action.step.id, action.resume));
        return { action: action.kind, more: !rec.waitingUntil && rec.stage !== "failed" };
      case "review":
        await save(await review(d, x, rec, action.round));
        return { action: action.kind, more: rec.stage === "reviewing" || rec.stage === "opening" };
      case "open-pull-request":
        // The review rounds ran out: what's left goes in the pull request; inbox mode asks you first.
        if (rec.stage === "reviewing") {
          const stage = rec.mode === "auto" ? "opening" : "ready";
          await save({ ...rec, stage });
          return { action: action.kind, more: stage === "opening" };
        }
        await save(await open(d, x, rec));
        return { action: action.kind, more: false };
    }
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 500);
    await save({ ...rec, stage: "failed", error });
    d.onTask?.({ type: "failed", task: id, error });
    await logTask(d, id, { type: "failed", error });
    return { action: action.kind, more: false };
  }
}

/** Advance until the task needs you or can't go on (approval, a blocker, a paused seat, done). */
export async function runTask(d: TaskDeps, x: PrTarget, id: string, maxActions = 60): Promise<TaskRecord | undefined> {
  for (let i = 0; i < maxActions; i++) {
    if (d.signal?.aborted) break;
    const r = await advanceTask(d, x, id);
    if (!r.more) break;
  }
  return loadTask(d, id);
}

/** No seat now: the task waits for the first to come back from its usage limit, or fails when none can do it. */
function noSeat(rec: TaskRecord, e: PickError): TaskRecord {
  if (e.error === "paused") return { ...rec, waitingUntil: e.until };
  return { ...rec, stage: "failed", error: `no seat: ${e.error}${"name" in e ? ` (${e.name})` : ""}` };
}

async function plan(d: TaskDeps, x: PrTarget, rec0: TaskRecord): Promise<TaskRecord> {
  const { dir, rec } = await workspace(d, x, rec0);
  await writeContext(dir, rec);
  const picker = await seatFor(d, "plan");
  if (isPickError(picker)) return noSeat(rec, picker);
  const c = await picker([]);
  if (isPickError(c)) return noSeat(rec, c);
  const r = await runAgent(d, rec, "plan", c, dir, planPrompt({ owner: await ownerOf(x), language: languageFor(d), dir: ATTEND_DIR }));
  if (!r.ok) return r.failure === "quota" ? rec : { ...rec, stage: "failed", error: `plan: ${r.failure}: ${(r.error ?? "").split("\n")[0]}` };
  // Planning is read-only: the harness's lock holds, and a stray change is thrown away all the same.
  if ((await changedPaths(dir)).length) await gitOk(["checkout", "--", "."], dir).catch(() => {});
  const p = parsePlan(extractJson(r.text));
  if (!p) return { ...rec, stage: "failed", error: `plan: the planner's answer wasn't a plan (it's in answers/ in the task's folder): ${r.text.replace(/\s+/g, " ").slice(0, 160)}` };
  const handoff = { role: "plan" as const, seat: c.seat, at: Date.now(), done: [], next: p.steps[0]!.id, blockers: [], notes: p.summary, files: [] };
  const next = applyHandoff({ ...rec, plan: p }, handoff);
  await writeHandoff(d, next);
  d.onTask?.({ type: "planned", task: rec.id, steps: p.steps.length });
  // The plan's first step shouldn't show as under way before anyone built it.
  return { ...next, plan: { ...p }, turns: 0, stage: rec.mode === "auto" ? "building" : "approval" };
}

async function writeHandoff(d: TaskDeps, rec: TaskRecord): Promise<void> {
  const h = rec.handoffs.at(-1);
  if (!h) return;
  await writeFile(join(taskDir(d, rec.id), "handoffs", `${String(h.n).padStart(3, "0")}-${h.role}-${h.seat}.md`), handoffMarkdown(h, rec.plan));
  await logTask(d, rec.id, { type: "handoff", n: h.n, role: h.role, seat: h.seat, done: h.done, cut: h.cut });
}

/** The task's branch, as far as it's committed, saved in the mirror so a new checkout picks up from there. */
async function saveProgress(mirror: string, dir: string, id: string): Promise<void> {
  const head = (await gitOk(["rev-parse", "HEAD"], dir)).trim();
  await gitOk(["update-ref", `refs/crewreview/task/${id}`, head], mirror);
}

async function build(d: TaskDeps, x: PrTarget, rec0: TaskRecord, stepId: string, resume: boolean, fix?: { findings: string }): Promise<TaskRecord> {
  const { mirror, dir, rec } = await workspace(d, x, rec0);
  const step = rec.plan!.steps.find((s) => s.id === stepId) ?? rec.plan!.steps[0]!;
  const failedCheck = rec.handoffs.at(-1)?.notes.startsWith(CHECKS_FAILED) ? rec.handoffs.at(-1)!.notes.slice(CHECKS_FAILED.length) : undefined;
  await writeContext(dir, rec, fix ? { "findings.json": fix.findings } : {});
  const picker = await seatFor(d, "build");
  if (isPickError(picker)) return noSeat(rec, picker);
  const c = await picker([]);
  if (isPickError(c)) return noSeat(rec, c);
  const prompt = buildPrompt({ owner: await ownerOf(x), language: languageFor(d), dir: ATTEND_DIR, step, resume, fixFindings: !!fix, ...(failedCheck ? { failedCheck } : {}) });
  const r = await runAgent(d, rec, "build", c, dir, prompt, fix ? "review-fixes" : step.id);
  const files = await changedPaths(dir);
  if (!r.ok) {
    // Cut off: code writes the handoff the agent couldn't, from what it left in the checkout.
    const cut: Handoff["cut"] = r.failure === "quota" ? "quota" : r.failure === "timeout" || r.failure === "stalled" ? "timeout" : "crash";
    const next = applyHandoff(rec, { role: "build", seat: c.seat, at: Date.now(), done: [], next: `Continue ${step.id}: ${step.title}`, blockers: [], notes: `${r.failure}: ${(r.error ?? "").split("\n")[0]}`, files, cut });
    await writeHandoff(d, next);
    return next;
  }
  const said = parseHandoff(extractJson(r.text), rec.plan!) ?? { done: [], next: "", blockers: [], notes: "The agent's report wasn't valid JSON." };
  let done = fix ? [] : said.done;
  let notes = said.notes;
  // The project's own checks, never commands from the plan: a model wrote those.
  const repo = x.repo;
  if ((done.length || fix) && files.length && repo.attend.validate.length) {
    const checks = await runChecks(repo.attend.validate, dir, d.config.attend.validateTimeout);
    const failed = checks.find((v) => !v.ok);
    if (failed) {
      d.onTask?.({ type: "checks-failed", task: rec.id, command: failed.command });
      done = [];
      notes = `${CHECKS_FAILED}$ ${failed.command}\n${failed.output}`;
    }
  }
  let next = applyHandoff(rec, { role: "build", seat: c.seat, at: Date.now(), done, next: said.next, blockers: said.blockers, notes, files });
  if ((done.length || (fix && !notes.startsWith(CHECKS_FAILED))) && files.length) {
    const steps = done.map((id) => next.plan!.steps.find((s) => s.id === id)).filter((s) => !!s);
    const subject = shorten(fix ? "Address the crew's self-review" : steps.map((s) => s.title).join("; ") || stepId, 72);
    const detail = steps.map((s) => s.detail).filter(Boolean).join("\n\n");
    const message = [subject, ...(detail ? ["", detail] : []), "", `Task: ${rec.text.split("\n")[0]!.slice(0, 200)}`, "", `Assisted-by: Crewreview ${d.version} (${c.seat})`].join("\n");
    const commit = await commitAll(dir, message, { signing: d.signing, identity: d.identity });
    await saveProgress(mirror, dir, rec.id);
    for (const s of done) d.onTask?.({ type: "step-done", task: rec.id, step: s, commit });
    if (fix) next = { ...next, reviewRounds: next.reviewRounds + 1 };
  }
  await writeHandoff(d, next);
  return next;
}

async function review(d: TaskDeps, x: PrTarget, rec0: TaskRecord, round: number): Promise<TaskRecord> {
  if (d.config.task.maxReviewRounds === 0) return { ...rec0, stage: rec0.mode === "auto" ? "opening" : "ready" };
  const { mirror, dir, rec } = await workspace(d, x, rec0);
  const head = (await gitOk(["rev-parse", "HEAD"], dir)).trim();
  const limits = pickLimits(d.config, d.quota);
  const routed = await d.seats?.available("review");
  const harness = routed ?? (await pickReviewer(d.registry, d.config.harness.default, d.conformance, limits));
  if (isPickError(harness)) return noSeat({ ...rec, stage: "reviewing" }, harness);
  const all = await loadLenses(mirror, rec.baseSha!);
  const lenses = all.filter((l) => d.config.review.lenses.includes(l.id) || (l.source === "repo" && !BUILTIN_LENS_IDS.includes(l.id)));
  d.onTask?.({ type: "agent-start", task: rec.id, role: "review", seat: "crew", harness: harness.id });
  const report = await runReview(
    {
      target: { root: mirror, branch: rec.branch, base: rec.base, baseSha: rec.baseSha!, headSha: head, rulesRef: rec.baseSha!, ci: "none" },
      jobDir: join(taskDir(d, rec.id), "reviews", String(round)),
      lenses,
      partial: false,
      harness,
      lensSeats: routed ? d.seats?.picker("review") : undefined,
      verifySeats: routed ? d.seats?.picker("verify") : undefined,
      config: d.config,
      language: languageFor(d),
      policy: d.config.review.policy,
      signal: d.signal,
    },
    d.version,
  );
  const blocking = report.findings.filter((f) => f.severity === "blocker" || f.severity === "major");
  d.onTask?.({ type: "reviewed", task: rec.id, findings: report.findings.length, blocking: blocking.length, round });
  const items = report.findings.slice(0, 15).map(({ severity, path, line, title }) => ({ severity, path, line, title }));
  const reviewed = { ...rec, stage: "reviewing" as const, lastReview: { findings: report.findings.length, blocking: blocking.length, event: report.verdict.event, items } };
  if (blocking.length === 0 || round > d.config.task.maxReviewRounds) {
    return { ...reviewed, reviewRounds: Math.max(reviewed.reviewRounds, round), stage: rec.mode === "auto" ? "opening" : "ready" };
  }
  // Blocking findings: one builder turn to fix them, then the next round reviews again.
  const findings = JSON.stringify(report.findings.map(({ path, line, severity, title, body }) => ({ path, line, severity, title, body })), null, 2);
  const lastStep = rec.plan!.steps.at(-1)!.id;
  const fixed = await build(d, x, reviewed, lastStep, true, { findings });
  // A fix that didn't land (cut off, checks failed) still counts as a round, so this ends.
  return { ...fixed, stage: fixed.stage === "failed" ? "failed" : "reviewing", reviewRounds: Math.max(fixed.reviewRounds, round) };
}

/** Push the branch with your token and open the pull request; the attendant answers its reviews from there. */
async function open(d: TaskDeps, x: PrTarget, rec0: TaskRecord): Promise<TaskRecord> {
  if (!x.host.openPullRequest) return { ...rec0, stage: "failed", error: "this host can't open pull requests yet" };
  const { mirror, dir, rec } = await workspace(d, x, rec0);
  const ahead = rec.baseSha ? (await gitOk(["rev-list", "--count", `${rec.baseSha}..HEAD`], dir)).trim() : "0";
  if (ahead === "0") return { ...rec, stage: "failed", error: "nothing was committed: no pull request to open" };
  const pushed = await pushHead(dir, rec.branch, gitAuthEnv(x.repo.ref, x.token));
  if (!pushed.ok) return { ...rec, stage: "failed", error: `push: ${pushed.error}` };
  const title = rec.plan?.title ?? shorten(rec.text.split("\n")[0]!, 72);
  const pr = await x.host.openPullRequest({ head: rec.branch, base: rec.base, title, body: pullRequestBody(rec, d.version) });
  d.onTask?.({ type: "opened", task: rec.id, url: pr.url });
  await logTask(d, rec.id, { type: "opened", url: pr.url, number: pr.number });
  await removeWorktree(mirror, dir).catch(() => {});
  return { ...rec, stage: "done", pr };
}

/** The pull request's description: the task, the plan as built, and what the crew's own review left. */
export function pullRequestBody(rec: TaskRecord, version: string): string {
  const lines = [rec.text, "", "### Plan", "", rec.plan?.summary ?? "", ""];
  for (const s of rec.plan?.steps ?? []) lines.push(`- [${s.status === "done" ? "x" : " "}] ${s.title}`);
  if (rec.plan?.risks.length) lines.push("", "### Risks", "", ...rec.plan.risks.map((r) => `- ${r}`));
  if (rec.lastReview) {
    lines.push("", "### Self-review", "", `${rec.lastReview.findings} finding(s) in the last round, ${rec.lastReview.blocking} blocking, after ${rec.reviewRounds} round(s).`);
    // What it found and didn't fix (minor ones, or what the rounds left): for the people who review it next.
    if (rec.lastReview.items?.length) lines.push("", ...rec.lastReview.items.map((f) => `- ${f.severity} · \`${f.path}:${f.line}\` ${f.title}`));
  }
  const seats = [...new Set(rec.handoffs.map((h) => h.seat))];
  lines.push("", `<sub>Planned, built and self-reviewed by Crewreview ${version}'s crew (${seats.join(", ")}). Merging stays with a person.</sub>`, makeMarker({ kind: "summary", ref: `task:${rec.id}`, version }));
  return lines.join("\n");
}
