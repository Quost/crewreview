import type { Translator } from "@crewreview/i18n";

/** One line for the activity log, in the reader's language. */
export function describe(t: Translator, e: any): { text: string; tone: "neutral" | "ok" | "warn" | "bad" } {
  const ref = (x: { repo: string; number: number }) => ({ repo: x.repo, number: x.number });
  switch (e.type) {
    case "start":
      return { text: t.t("web.log.reviewStarted", { ...ref(e), title: e.title }), tone: "neutral" };
    case "skip":
      return { text: t.t("review.skipped", { ...ref(e), reason: t.t(`skip.${e.reason}` as never) }), tone: "neutral" };
    case "cycle":
      return { text: t.t("run.cycle", { repos: t.tp("run.repoCount", e.repos), reviewed: e.reviewed, waiting: e.waiting }), tone: "neutral" };
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
      if (o.kind === "done") return { text: t.t("attend.done", { ...ref(e), replies: o.replies, resolved: o.resolved }), tone: "ok" };
      if (o.kind === "pending") return { text: t.t("web.log.answerWaiting", { ...ref(e), fixed: o.fixed, replies: o.replies }), tone: "warn" };
      if (o.kind === "waiting") return { text: o.reason === "fork" ? t.t("attend.fork", ref(e)) : o.reason === "busy" ? t.t("attend.busy", ref(e)) : t.t("attend.settling", ref(e)), tone: "neutral" };
      if (o.kind === "stale") return { text: t.t("attend.stale", { id: `f${o.attendId}` }), tone: "warn" };
      if (o.kind === "harness") return harnessLine(t, e, o.error);
      return { text: t.t("attend.failed", { ...ref(e), error: String(o.error ?? "").split("\n")[0]!.slice(0, 200) }), tone: "bad" };
    }
    case "update":
      return e.error
        ? { text: t.t("update.failed", { error: e.error }), tone: "bad" }
        : { text: e.installed ? t.t("web.log.updateInstalled", { version: e.version }) : t.t("web.log.updateAvailable", { version: e.version }), tone: e.installed ? "ok" : "warn" };
    default:
      return { text: JSON.stringify(e), tone: "neutral" };
  }
}

function harnessLine(t: Translator, e: { repo: string; number: number }, error: any): { text: string; tone: "bad" } {
  if (error?.error === "paused")
    return { text: t.t("web.log.paused", { repo: e.repo, number: e.number, name: error.name, when: new Date(error.until).toLocaleString(t.locale, { weekday: "short", hour: "2-digit", minute: "2-digit" }) }), tone: "bad" };
  if (error?.error === "budget") return { text: t.t("web.log.budget", { repo: e.repo, number: e.number, limit: error.limit }), tone: "bad" };
  if (error?.error === "signed-out") return { text: t.t("web.log.signedOut", { repo: e.repo, number: e.number, name: error.name, command: error.command ?? "" }), tone: "bad" };
  return { text: t.t("web.log.noHarness", { repo: e.repo, number: e.number }), tone: "bad" };
}
