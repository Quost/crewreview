import { approveTask, cancelTask, connect, createTask, isOrg, listTasks, loadTask, runTask, type TaskEvent, type TaskRecord } from "@crewreview/engine";
import { HostError } from "@crewreview/hosts";
import type { Ctx } from "../ctx.ts";
import { findRepo, noTokenText } from "./repo.ts";
import { deps } from "./review.ts";

export interface TaskArgs {
  repo?: string;
  base?: string;
  auto: boolean;
}

const USAGE = 'crewreview task "<what to do>" --repo <id> [--base <branch>] [--auto] | task [list | show <id> | approve <id> | run <id> | cancel <id>]';

/**
 * Crew mode from the terminal: give the crew a task, read its plan, approve it, and let it build, review itself and
 * open the pull request. The ledger lives in Crewreview's data folder (tasks/<id>/), readable at every step.
 */
export async function task(c: Ctx, rest: string[], a: TaskArgs): Promise<number> {
  const { t } = c;
  const [sub, id] = rest;
  const d = deps(c);
  try {
    if (!sub || sub === "list") {
      const all = await listTasks(d);
      if (all.length === 0) return (c.out(t.t("task.none")), 0);
      for (const r of all) c.out(`${r.id.padEnd(44)} ${stageText(c, r).padEnd(30)} ${c.style.dim(r.repo)}`);
      return 0;
    }
    if (sub === "show") return show(c, id ? await loadTask(d, id) : undefined, id);
    if (sub === "approve" || sub === "run" || sub === "cancel") {
      const rec = id ? await loadTask(d, id) : undefined;
      if (!rec) return (c.err(t.t("task.notFound", { id: id ?? "" })), 2);
      if (sub === "cancel") {
        await cancelTask(d, rec.id);
        c.out(t.t("task.cancelled", { id: rec.id }));
        return 0;
      }
      if (sub === "approve" && !(await approveTask(d, rec.id))) return (c.err(t.t("task.nothingToApprove", { id: rec.id, stage: stageText(c, rec) })), 2);
      return go(c, d, rec);
    }
    // Anything else is the task itself: `crewreview task "Add discount codes" --repo shop`.
    const text = rest.join(" ").trim();
    if (!text || !a.repo) return (c.err(t.t("error.usage", { usage: USAGE })), 2);
    const repo = await findRepo(c, a.repo);
    if (typeof repo === "string") return (c.err(repo), 2);
    if (isOrg(repo)) return (c.err(t.t("task.needsRepo", { id: repo.id })), 2);
    const target = await connect(repo, c.version);
    if ("error" in target) return (c.err(noTokenText(c, repo)), 2);
    const rec = await createTask(d, target, text, { base: a.base, mode: a.auto ? "auto" : "inbox" });
    c.out(t.t("task.created", { id: rec.id, branch: rec.branch, base: rec.base }));
    return go(c, d, rec);
  } catch (e) {
    if (e instanceof HostError) return (c.err(t.t("error.host", { message: e.message })), 1);
    throw e;
  } finally {
    d.close();
  }
}

/** Run the task as far as it goes without you, then say where it stands and what you can do. */
async function go(c: Ctx, d: ReturnType<typeof deps>, rec: TaskRecord): Promise<number> {
  const repo = await findRepo(c, rec.repo);
  if (typeof repo === "string") return (c.err(repo), 2);
  const target = await connect(repo, c.version);
  if ("error" in target) return (c.err(noTokenText(c, repo)), 2);
  const after = await runTask({ ...d, onTask: (e) => progress(c, e) }, target, rec.id);
  c.err();
  return show(c, after, rec.id);
}

function progress(c: Ctx, e: TaskEvent): void {
  const { t, style: st } = c;
  const line = (() => {
    switch (e.type) {
      case "agent-start":
        return st.dim(`▸ ${t.t(`task.role.${e.role}` as never)}${e.step ? ` · ${e.step}` : ""} · ${e.seat === e.harness ? e.harness : `${e.seat} (${e.harness})`}`);
      case "agent-done":
        return e.ok ? undefined : st.yellow(`  ${t.t("task.agentFailed", { error: e.error ?? "" })}`);
      case "planned":
        return st.green(`  ✓ ${t.tp("task.planned", e.steps)}`);
      case "step-done":
        return st.green(`  ✓ ${t.t("task.stepDone", { step: e.step, commit: e.commit?.slice(0, 7) ?? "" })}`);
      case "checks-failed":
        return st.yellow(`  ! ${t.t("task.checksFailed", { command: e.command })}`);
      case "reviewed":
        return `  ${t.t("task.reviewed", { round: e.round, findings: e.findings, blocking: e.blocking })}`;
      case "opened":
        return st.green(`  ✓ ${t.t("task.opened", { url: e.url })}`);
      case "waiting":
        return st.yellow(`  ${t.t("task.waiting", { when: e.until ? new Date(e.until).toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" }) : "?" })}`);
      case "asks":
        return st.yellow(`  ? ${t.t(`task.asks.${e.reason}` as never, { step: e.step ?? "" })}`);
      case "failed":
        return st.red(`  ✗ ${e.error}`);
    }
  })();
  if (line) c.err(line);
}

function stageText(c: Ctx, r: TaskRecord): string {
  return c.t.t(`task.stage.${r.stage}` as never);
}

function show(c: Ctx, r: TaskRecord | undefined, id?: string): number {
  const { t, style: st } = c;
  if (!r) return (c.err(t.t("task.notFound", { id: id ?? "" })), 2);
  c.out(st.bold(r.text.split("\n")[0]!));
  c.out(st.dim(`${r.id} · ${r.repo} · ${r.branch} → ${r.base}`));
  c.out(`${t.t("task.stageLabel")}: ${stageText(c, r)}${r.error ? st.red(` (${r.error})`) : ""}`);
  if (r.plan) {
    c.out();
    c.out(r.plan.summary);
    const mark = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" } as const;
    for (const s of r.plan.steps) c.out(`  ${mark[s.status]} ${s.id}: ${s.title}${s.files.length ? st.dim(`  ${s.files.join(", ")}`) : ""}`);
    if (r.plan.risks.length) c.out(st.dim(`  ${t.t("task.risks")}: ${r.plan.risks.join("; ")}`));
  }
  if (r.pr) c.out(st.green(t.t("task.opened", { url: r.pr.url })));
  c.out();
  if (r.stage === "approval") c.out(t.t("task.nextApprovePlan", { id: r.id }));
  else if (r.stage === "ready") c.out(t.t("task.nextApproveOpen", { id: r.id }));
  else if (r.stage !== "done" && r.stage !== "cancelled" && r.stage !== "failed") c.out(t.t("task.nextRun", { id: r.id }));
  return r.stage === "failed" ? 1 : 0;
}
