import type { Translator } from "@crewreview/i18n";

/** One line for the activity log, in the reader's language. */
export function describe(t: Translator, e: any): { text: string; tone: "neutral" | "ok" | "warn" | "bad" } {
  const ref = (x: { repo: string; number: number }) => ({ repo: x.repo, number: x.number });
  switch (e.type) {
    case "start":
      return { text: t.t("web.log.reviewStarted", { ...ref(e), title: e.title }), tone: "neutral" };
    case "skip":
      return { text: t.t("review.skipped", { ...ref(e), reason: t.t(`skip.${e.reason}` as never) }), tone: "neutral" };
    case "task": {
      const ev = e.event;
      const name = { task: e.title.length > 60 ? `${e.title.slice(0, 59)}…` : e.title };
      if (ev.type === "planned") return { text: t.t("web.log.taskPlanned", { ...name, steps: ev.steps }), tone: "warn" };
      if (ev.type === "step-done") return { text: t.t("web.log.taskStep", { ...name, step: ev.step }), tone: "ok" };
      if (ev.type === "checks-failed") return { text: t.t("web.log.taskChecks", { ...name, command: ev.command }), tone: "warn" };
      if (ev.type === "reviewed") return { text: t.t("web.log.taskReviewed", { ...name, findings: ev.findings, blocking: ev.blocking }), tone: ev.blocking ? "warn" : "ok" };
      if (ev.type === "opened") return { text: t.t("web.log.taskOpened", { ...name, url: ev.url }), tone: "ok" };
      if (ev.type === "waiting") return { text: t.t("web.log.taskWaiting", name), tone: "warn" };
      if (ev.type === "asks") return { text: t.t("web.log.taskAsks", { ...name, step: ev.step ?? "" }), tone: "warn" };
      return { text: t.t("web.log.taskFailed", { ...name, error: String(ev.error ?? "").slice(0, 200) }), tone: "bad" };
    }
    case "cycle": {
      const text = t.t("run.cycle", { repos: t.tp("run.repoCount", e.repos), reviewed: e.reviewed, waiting: e.waiting });
      if (!e.offline?.length) return { text, tone: "neutral" };
      return { text: `${text} ${t.t("run.offline", { repos: e.offline.join(", ") })}`, tone: "warn" };
    }
    case "repo-error":
      return { text: `${e.repo}: ${e.code === "no-token" ? t.t("web.log.noToken") : e.error}`, tone: "bad" };
    case "outcome": {
      const o = e.outcome;
      if (o.kind === "posted") return { text: t.t("web.log.posted", { ...ref(e), event: t.t(`verdict.${o.event}` as never) }), tone: "ok" };
      if (o.kind === "pending") return { text: t.t("web.log.reviewWaiting", { ...ref(e), findings: o.findings }), tone: "warn" };
      if (o.kind === "skipped" && o.reason === "too-large") return { text: t.t("review.tooLarge", { ...ref(e), lines: o.lines ?? "?", limit: o.limit ?? "?" }), tone: "warn" };
      if (o.kind === "skipped") return { text: o.reason === "merge-only" ? t.t("review.mergeOnly", ref(e)) : t.t("review.alreadyOnHost", ref(e)), tone: "neutral" };
      if (o.kind === "stale") return { text: t.t("review.stale", { id: `r${o.reviewId}` }), tone: "warn" };
      if (o.kind === "harness") return harnessLine(t, e, o.error);
      return { text: t.t("review.failed", { ...ref(e), error: String(o.error ?? "").split("\n")[0]!.slice(0, 200) }), tone: "bad" };
    }
    case "attend-outcome": {
      const o = e.outcome;
      if (o.kind === "done") {
        const text = o.synced
          ? t.t(o.synced.why === "restack" ? "attend.restacked" : "attend.synced", { ...ref(e), base: o.synced.base, parent: o.synced.parent })
          : t.t("attend.done", { ...ref(e), replies: o.replies, resolved: o.resolved });
        const left = leftText(t, o.left);
        if (!o.unresolved) return { text: `${text}${left}`, tone: left ? "warn" : "ok" };
        return { text: `${text} ${t.tp("attend.unresolved", o.unresolved, { error: String(o.resolveError ?? "").slice(0, 200) })}${left}`, tone: "warn" };
      }
      if (o.kind === "pending") return { text: `${t.t("web.log.answerWaiting", { ...ref(e), fixed: o.fixed, replies: o.replies })}${leftText(t, o.left)}`, tone: "warn" };
      if (o.kind === "waiting") return { text: o.reason === "fork" ? t.t("attend.fork", ref(e)) : o.reason === "busy" ? t.t("attend.busy", ref(e)) : t.t("attend.settling", ref(e)), tone: "neutral" };
      if (o.kind === "stale") return { text: t.t("attend.stale", { id: `f${o.attendId}` }), tone: "warn" };
      if (o.kind === "harness") return harnessLine(t, e, o.error);
      return { text: t.t("attend.failed", { ...ref(e), error: String(o.error ?? "").split("\n")[0]!.slice(0, 200) }), tone: "bad" };
    }
    case "cli-linked":
      return { text: t.t(e.was ? "cli.linked" : "cli.relinked", { path: e.path, version: e.was ?? "" }), tone: "ok" };
    case "update":
      return e.error
        ? { text: t.t("update.failed", { error: e.error }), tone: "bad" }
        : { text: e.installed ? t.t("web.log.updateInstalled", { version: e.version }) : t.t("web.log.updateAvailable", { version: e.version }), tone: e.installed ? "ok" : "warn" };
    default:
      return { text: JSON.stringify(e), tone: "neutral" };
  }
}

const LEFT_KIND = {
  thread: "attend.leftKind.thread",
  review: "attend.leftKind.review",
  comment: "attend.leftKind.comment",
  conflict: "attend.leftKind.conflict",
  ci: "attend.leftKind.ci",
} as const;

/** " Left for you: AGENTS.md:44, @bia." The items the attendant left for you, so you know which threads to open. */
export function leftText(t: Translator, left: { kind: string; path?: string; line?: number; author?: string }[] | undefined): string {
  if (!left?.length) return "";
  const where = left.map((x) => (x.path ? `${x.path}${x.line ? `:${x.line}` : ""}` : x.author ? `@${x.author}` : t.t(LEFT_KIND[x.kind as keyof typeof LEFT_KIND] ?? "attend.leftKind.thread")));
  return ` ${t.t("attend.left", { items: where.join(", ") })}`;
}

/** Why no harness could take the job, and what to do about it: each problem has its own way out. */
function harnessLine(t: Translator, e: { repo: string; number: number }, error: any): { text: string; tone: "bad" } {
  const pr = { repo: e.repo, number: e.number };
  const at = (text: string) => ({ text: `${e.repo}#${e.number}: ${text}`, tone: "bad" as const });
  switch (error?.error) {
    case "paused":
      return { text: t.t("web.log.paused", { ...pr, name: error.name, when: new Date(error.until).toLocaleString(t.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }) }), tone: "bad" };
    case "budget":
      return { text: t.t("web.log.budget", { ...pr, limit: error.limit }), tone: "bad" };
    case "signed-out":
      return { text: t.t("web.log.signedOut", { ...pr, name: error.name, command: error.command ?? "" }), tone: "bad" };
    case "needs-conformance":
    case "needs-write-check":
      return { text: t.t("web.log.needsProof", { ...pr, name: error.name }), tone: "bad" };
    case "unknown-harness":
      return at(t.t("error.unknownHarness", { name: error.name }));
    case "no-harness":
      return at(t.t("error.noHarness"));
    case "cannot-write":
      return at(t.t("error.cannotWrite", { name: error.name }));
    case "write-escapes":
      return at(t.t("error.writeEscapes", { name: error.name }));
    default:
      return at(t.t("error.harnessNotReadOnly", { name: error?.name ?? "?" }));
  }
}

export interface LogLine {
  at: number;
  event: any;
}

/** A line of the activity log; `quiet` when it stands for several empty checks in a row. */
export type FoldedEntry<T extends LogLine = LogLine> = T & { quiet?: { count: number; since: number } };

const isQuiet = (e: any): boolean => e?.type === "cycle" && !e.reviewed && !e.waiting && !e.offline?.length;

/**
 * Empty checks in a row, with nothing else said between them, become one line: the latest, with how many and since
 * when. A check every few minutes that found nothing isn't news each time.
 */
export function foldQuiet<T extends LogLine>(log: readonly T[]): FoldedEntry<T>[] {
  const out: FoldedEntry<T>[] = [];
  for (const e of log) {
    const last = out[out.length - 1];
    if (last && isQuiet(e.event) && isQuiet(last.event) && last.event.repos === e.event.repos) {
      out[out.length - 1] = { ...e, quiet: { count: (last.quiet?.count ?? 1) + 1, since: last.quiet?.since ?? last.at } };
    } else out.push(e);
  }
  return out;
}

/** One line for a folded log entry. */
export function describeEntry(t: Translator, x: FoldedEntry): { text: string; tone: "neutral" | "ok" | "warn" | "bad" } {
  if (!x.quiet) return describe(t, x.event);
  const since = new Date(x.quiet.since).toLocaleTimeString(t.locale, { hour: "2-digit", minute: "2-digit" });
  return { text: t.t("web.log.quiet", { repos: t.tp("run.repoCount", x.event.repos), count: x.quiet.count, since }), tone: "neutral" };
}
