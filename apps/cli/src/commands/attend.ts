import { attendPullRequest, connect, type AttendOutcome, type AttendPayload } from "@crewreview/engine";
import { HostError } from "@crewreview/hosts";
import { pickErrorText, type Ctx } from "../ctx.ts";
import { findRepo, noTokenText } from "./repo.ts";
import { deps } from "./review.ts";

export function attendText(c: Ctx, repo: string, number: number, o: AttendOutcome): string {
  const { t, style: st } = c;
  switch (o.kind) {
    case "nothing":
      return st.dim(t.t("attend.nothing", { repo, number }));
    case "waiting":
      return st.dim(o.reason === "fork" ? t.t("attend.fork", { repo, number }) : o.reason === "settling" ? t.t("attend.settling", { repo, number }) : t.t("attend.notYours", { repo, number }));
    case "pending": {
      const line = t.t("attend.pending", { repo, number, id: `f${o.attendId}`, fixed: o.fixed, replies: o.replies });
      return o.forced ? `${line}\n${st.yellow(t.t(`attend.forced.${o.forced}`))}` : line;
    }
    case "done": {
      const parts = [st.green(t.t("attend.done", { repo, number, replies: o.replies, resolved: o.resolved }))];
      if (o.commit) parts.push(t.t("attend.pushed", { sha: o.commit.slice(0, 7) }));
      if (o.reReview) parts.push(t.t("attend.reReview"));
      if (o.needsHuman) parts.push(st.yellow(t.tp("attend.needsHuman", o.needsHuman)));
      return parts.join(" ");
    }
    case "stale":
      return st.yellow(t.t("attend.stale", { id: `f${o.attendId}` }));
    case "failed":
      return st.red(t.t("attend.failed", { repo, number, error: o.error.split("\n")[0]!.slice(0, 300) }));
    case "harness":
      return st.red(pickErrorText(c, o.error));
    case "dry-run":
      return "";
  }
}

export function renderPayload(c: Ctx, p: AttendPayload): string {
  const { t, style: st } = c;
  const lines = [st.bold(t.t("inbox.decisions"))];
  for (const d of p.decisions) {
    const item = p.items.find((i) => i.key === d.key);
    const where = item?.path ? `${item.path}${item.line ? `:${item.line}` : ""}` : (item?.author ?? "");
    const label = t.t(`decision.${d.action}`);
    const color = d.action === "fixed" ? st.green : d.action === "needs-human" ? st.yellow : st.cyan;
    lines.push(`  ${color(label.padEnd(14))} ${st.bold(where)} ${st.dim(`(${item?.author ?? "?"})`)}`);
    const first = item?.text.split("\n").find((l) => l.trim())?.slice(0, 140);
    if (first) lines.push(st.dim(`      ${first}`));
    if (d.reply) for (const l of d.reply.trim().split("\n")) lines.push(`      → ${l}`);
  }
  if (p.changed.length) lines.push("", t.t("inbox.changed", { files: p.changed.join(", ") }));
  for (const v of p.validation) lines.push(`${v.ok ? st.green("✓") : st.red("✗")} ${v.command}${v.ok ? "" : `\n${st.dim(v.output)}`}`);
  if (p.forcedInbox) lines.push(st.yellow(t.t(`attend.forced.${p.forcedInbox}`)));
  return lines.join("\n");
}

export interface AttendArgs {
  post: boolean;
  dryRun: boolean;
}

export async function attendOne(c: Ctx, repoArg: string | undefined, numberArg: string | undefined, a: AttendArgs): Promise<number> {
  const { t } = c;
  if (!repoArg || !numberArg) return (c.err(t.t("error.usage", { usage: "crewreview attend <repo> <number> [--post | --dry-run]" })), 2);
  const number = Number(numberArg.replace(/^[#!]/, ""));
  if (!Number.isInteger(number) || number <= 0) return (c.err(t.t("error.badNumber", { value: numberArg })), 2);
  const repo = await findRepo(c, repoArg);
  if (typeof repo === "string") return (c.err(repo), 2);
  const target = await connect(repo, c.version);
  if ("error" in target) return (c.err(noTokenText(c, repo)), 2);
  const d = deps(c);
  try {
    const o = await attendPullRequest(d, target, number, a.dryRun ? "dry-run" : a.post ? "auto" : "inbox");
    if (o.kind === "dry-run") {
      c.out(renderPayload(c, o.payload));
      if (o.diff) c.out(`\n${c.style.dim(o.diff)}`);
      return 0;
    }
    if (o.kind === "pending") {
      const row = d.store.getAttend(o.attendId);
      if (row?.payload) c.out(`${renderPayload(c, JSON.parse(row.payload))}\n`);
    }
    c.out(attendText(c, repo.id, number, o));
    return o.kind === "failed" || o.kind === "harness" ? 1 : 0;
  } catch (e) {
    if (e instanceof HostError) return (c.err(t.t("error.host", { message: e.message })), 1);
    throw e;
  } finally {
    d.close();
  }
}
