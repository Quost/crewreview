import { attendPullRequest, connect, type AttendOutcome, type AttendPayload } from "@crewreview/engine";
import type { LeftItem } from "@crewreview/core";
import { HostError } from "@crewreview/hosts";
import { pickErrorText, type Ctx } from "../ctx.ts";
import { findRepo, noTokenText } from "./repo.ts";
import { deps } from "./review.ts";

export function attendText(c: Ctx, repo: string, number: number, o: AttendOutcome): string {
  const { t, style: st } = c;
  switch (o.kind) {
    case "nothing":
      return o.blocked ? st.yellow(t.tp("attend.nothingBlocked", o.blocked, { repo, number })) : st.dim(t.t("attend.nothing", { repo, number }));
    case "waiting":
      return st.dim(
        o.reason === "fork"
          ? t.t("attend.fork", { repo, number })
          : o.reason === "settling"
            ? t.t("attend.settling", { repo, number })
            : o.reason === "busy"
              ? t.t("attend.busy", { repo, number })
              : t.t("attend.notYours", { repo, number }),
      );
    case "pending": {
      const line = t.t("attend.pending", { repo, number, id: `f${o.attendId}`, fixed: o.fixed, replies: o.replies }) + leftText(t, o.left);
      return o.forced ? `${line}\n${st.yellow(t.t(`attend.forced.${o.forced}`, { files: (o.links ?? []).join(", ") }))}` : line;
    }
    case "done": {
      const parts = [
        st.green(
          o.synced
            ? t.t(o.synced.why === "restack" ? "attend.restacked" : "attend.synced", { repo, number, base: o.synced.base, parent: o.synced.parent })
            : t.t("attend.done", { repo, number, replies: o.replies, resolved: o.resolved }),
        ),
      ];
      if (o.commit) parts.push(t.t("attend.pushed", { sha: o.commit.slice(0, 7) }));
      if (o.reReview) parts.push(t.t("attend.reReview"));
      if (o.needsHuman) parts.push(st.yellow(t.tp("attend.needsHuman", o.needsHuman) + leftText(t, o.left)));
      if (o.unresolved) parts.push(st.yellow(t.tp("attend.unresolved", o.unresolved, { error: o.resolveError ?? "" })));
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

const LEFT_KIND = {
  thread: "attend.leftKind.thread",
  review: "attend.leftKind.review",
  comment: "attend.leftKind.comment",
  conflict: "attend.leftKind.conflict",
  ci: "attend.leftKind.ci",
} as const;

/** " Left for you: AGENTS.md:44, @bia." Which items the attendant left for you. */
function leftText(t: Ctx["t"], left: LeftItem[] | undefined): string {
  if (!left?.length) return "";
  const where = left.map((x) => (x.path ? `${x.path}${x.line ? `:${x.line}` : ""}` : x.author ? `@${x.author}` : t.t(LEFT_KIND[x.kind as keyof typeof LEFT_KIND] ?? "attend.leftKind.thread")));
  return ` ${t.t("attend.left", { items: where.join(", ") })}`;
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
  if (p.forcedInbox) lines.push(st.yellow(t.t(`attend.forced.${p.forcedInbox}`, { files: (p.links ?? []).join(", ") })));
  return lines.join("\n");
}

export interface AttendArgs {
  post: boolean;
  dryRun: boolean;
  /** Give up-on items another chance first. */
  retry: boolean;
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
    if (a.retry) {
      const n = d.store.resetItems(repo.id, number);
      if (n) c.err(c.style.dim(t.tp("attend.retrying", n)));
    }
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
