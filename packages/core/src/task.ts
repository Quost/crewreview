import { z } from "zod";

/**
 * Crew mode's task ledger, as rules (docs/plans/crew-mode.md, M8.2). A task goes plan → approval → build, step by
 * step, → self-review → pull request. Agents propose a plan and report each turn in a handoff; these functions decide
 * what happens next, so any seat can pick the task up from the ledger alone.
 */

export const STEP_STATUS = ["todo", "doing", "done", "blocked"] as const;
export type StepStatus = (typeof STEP_STATUS)[number];

export interface PlanStep {
  id: string;
  title: string;
  /** Files the step expects to touch: a hint for the builder and the reviewer, not a lock. */
  files: string[];
  /** How the step is checked: a command, or what to look at. */
  check?: string;
  status: StepStatus;
}

export interface TaskPlan {
  summary: string;
  steps: PlanStep[];
  risks: string[];
}

export type TaskStage = "planning" | "approval" | "building" | "reviewing" | "opening" | "done" | "failed" | "cancelled";

/** What one agent turn reported, written into handoffs/NNN-<role>-<seat>.md by code. */
export interface Handoff {
  n: number;
  role: "plan" | "build" | "review";
  seat: string;
  at: number;
  /** Steps it finished. */
  done: string[];
  /** What the next agent should do first. */
  next: string;
  blockers: string[];
  notes: string;
  files: string[];
  /** The agent was cut off (usage limit, timeout) and code wrote this from what it left behind. */
  cut?: "quota" | "timeout" | "crash";
}

export interface TaskState {
  id: string;
  stage: TaskStage;
  plan?: TaskPlan;
  handoffs: Handoff[];
  /** Agent turns spent building, so a task that never converges stops. */
  turns: number;
  /** Self-review rounds done. */
  reviewRounds: number;
  /** Paused until a seat comes back from its usage limit. */
  waitingUntil?: number;
  error?: string;
}

export interface TaskLimits {
  /** Most building turns before the task stops and asks you. */
  maxTurns: number;
  /** Most self-review rounds (review → fix) before the pull request opens with what's left. */
  maxReviewRounds: number;
}

export const DEFAULT_TASK_LIMITS: TaskLimits = { maxTurns: 12, maxReviewRounds: 2 };

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

const PlanSchema = z.object({
  summary: z.string().min(1).max(4000),
  steps: z
    .array(
      z.object({
        id: z.string().regex(ID),
        title: z.string().min(1).max(300),
        files: z.array(z.string().max(300)).max(60).default([]),
        check: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(30),
  risks: z.array(z.string().max(500)).max(20).default([]),
});

/**
 * The planner's answer, checked: at least one step, unique ids, no absolute paths or `..` in the files it names.
 * Undefined when it isn't a plan; the planner gets another try.
 */
export function parsePlan(value: unknown): TaskPlan | undefined {
  const r = PlanSchema.safeParse(value);
  if (!r.success) return undefined;
  const ids = new Set<string>();
  for (const s of r.data.steps) {
    if (ids.has(s.id)) return undefined;
    ids.add(s.id);
  }
  const safe = (f: string) => f.length > 0 && !f.startsWith("/") && !/^[a-z]:/i.test(f) && !f.split(/[\\/]/).includes("..");
  return {
    summary: r.data.summary,
    risks: r.data.risks,
    steps: r.data.steps.map((s) => ({ id: s.id, title: s.title, files: s.files.filter(safe), ...(s.check ? { check: s.check } : {}), status: "todo" as const })),
  };
}

const HandoffSchema = z.object({
  done: z.array(z.string()).default([]),
  next: z.string().max(2000).default(""),
  blockers: z.array(z.string().max(1000)).max(20).default([]),
  notes: z.string().max(4000).default(""),
});

/** A builder's report at the end of its turn, checked against the plan: steps it claims must exist. */
export function parseHandoff(value: unknown, plan: TaskPlan): Pick<Handoff, "done" | "next" | "blockers" | "notes"> | undefined {
  const r = HandoffSchema.safeParse(value);
  if (!r.success) return undefined;
  const known = new Set(plan.steps.map((s) => s.id));
  return { ...r.data, done: [...new Set(r.data.done.filter((id) => known.has(id)))] };
}

export type TaskAction =
  | { kind: "plan" }
  | { kind: "await-approval" }
  | { kind: "build"; step: PlanStep; resume: boolean }
  | { kind: "review"; round: number }
  | { kind: "open-pull-request" }
  | { kind: "wait"; until: number }
  | { kind: "ask"; reason: "blocked" | "too-many-turns" | "no-progress"; step?: string }
  | { kind: "stop" };

/**
 * What the task does next. Building takes the first step not done; a step whose last turn ended with a blocker, or
 * three turns in a row that finished nothing, stop and ask you instead of spinning.
 */
export function nextAction(t: TaskState, now: number, limits: TaskLimits = DEFAULT_TASK_LIMITS): TaskAction {
  if (t.stage === "done" || t.stage === "failed" || t.stage === "cancelled") return { kind: "stop" };
  if (t.waitingUntil !== undefined && t.waitingUntil > now) return { kind: "wait", until: t.waitingUntil };
  if (t.stage === "planning" || !t.plan) return { kind: "plan" };
  if (t.stage === "approval") return { kind: "await-approval" };
  if (t.stage === "building") {
    const blocked = t.plan.steps.find((s) => s.status === "blocked");
    if (blocked) return { kind: "ask", reason: "blocked", step: blocked.id };
    const step = t.plan.steps.find((s) => s.status !== "done");
    if (!step) return { kind: "review", round: t.reviewRounds + 1 };
    if (t.turns >= limits.maxTurns) return { kind: "ask", reason: "too-many-turns", step: step.id };
    const builds = t.handoffs.filter((h) => h.role === "build");
    const lastThree = builds.slice(-3);
    if (lastThree.length === 3 && lastThree.every((h) => h.done.length === 0 && !h.cut)) return { kind: "ask", reason: "no-progress", step: step.id };
    return { kind: "build", step, resume: step.status === "doing" || builds.length > 0 };
  }
  if (t.stage === "reviewing") return t.reviewRounds >= limits.maxReviewRounds ? { kind: "open-pull-request" } : { kind: "review", round: t.reviewRounds + 1 };
  if (t.stage === "opening") return { kind: "open-pull-request" };
  return { kind: "stop" };
}

/** The ledger after a building turn: finished steps marked done, the next one in progress or blocked. */
export function applyHandoff(t: TaskState, h: Omit<Handoff, "n">): TaskState {
  if (!t.plan) return t;
  const n = (t.handoffs.at(-1)?.n ?? 0) + 1;
  const done = new Set(h.done);
  let marked = false;
  const steps = t.plan.steps.map((s) => {
    if (done.has(s.id)) return { ...s, status: "done" as const };
    if (s.status === "done" || marked) return s;
    marked = true;
    // The first step left: blocked if the agent said so, otherwise the one under way.
    return { ...s, status: h.blockers.length > 0 && !h.cut ? ("blocked" as const) : ("doing" as const) };
  });
  return { ...t, plan: { ...t.plan, steps }, handoffs: [...t.handoffs, { ...h, n }], turns: h.role === "build" ? t.turns + 1 : t.turns, waitingUntil: undefined };
}

/** The handoff as the next agent reads it, and as you read it in the ledger. */
export function handoffMarkdown(h: Handoff, plan?: TaskPlan): string {
  const title = (id: string) => plan?.steps.find((s) => s.id === id)?.title ?? id;
  const lines = [`# Handoff ${h.n}: ${h.role} by ${h.seat}`, "", `At: ${new Date(h.at).toISOString()}`];
  if (h.cut) lines.push(`Cut off: ${h.cut}. Written by Crewreview from what the agent left, not by the agent.`);
  lines.push("", "## Done", ...(h.done.length ? h.done.map((id) => `- ${id}: ${title(id)}`) : ["- nothing finished"]));
  lines.push("", "## Next", h.next || "(not said)");
  if (h.blockers.length) lines.push("", "## Blockers", ...h.blockers.map((b) => `- ${b}`));
  if (h.files.length) lines.push("", "## Files touched", ...h.files.map((f) => `- ${f}`));
  if (h.notes) lines.push("", "## Notes", h.notes);
  return `${lines.join("\n")}\n`;
}

/** The plan as plan.md: what you approve, and what every agent reads first. */
export function planMarkdown(task: string, plan: TaskPlan): string {
  const mark: Record<StepStatus, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" };
  const lines = [`# ${task}`, "", plan.summary, "", "## Steps"];
  for (const s of plan.steps) {
    lines.push(`- ${mark[s.status]} **${s.id}**: ${s.title}`);
    if (s.files.length) lines.push(`  - files: ${s.files.join(", ")}`);
    if (s.check) lines.push(`  - check: ${s.check}`);
  }
  if (plan.risks.length) lines.push("", "## Risks", ...plan.risks.map((r) => `- ${r}`));
  return `${lines.join("\n")}\n`;
}
