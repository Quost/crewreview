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
      if (o.kind === "skipped") return { text: o.reason === "merge-only" ? t.t("review.mergeOnly", ref(e)) : t.t("review.alreadyOnHost", ref(e)), tone: "neutral" };
      if (o.kind === "stale") return { text: t.t("review.stale", { id: `r${o.reviewId}` }), tone: "warn" };
      if (o.kind === "harness") return { text: t.t("web.log.noHarness", ref(e)), tone: "bad" };
      return { text: t.t("review.failed", { ...ref(e), error: String(o.error ?? "").split("\n")[0]!.slice(0, 200) }), tone: "bad" };
    }
    case "attend-outcome": {
      const o = e.outcome;
      if (o.kind === "done") return { text: t.t("attend.done", { ...ref(e), replies: o.replies, resolved: o.resolved }), tone: "ok" };
      if (o.kind === "pending") return { text: t.t("web.log.answerWaiting", { ...ref(e), fixed: o.fixed, replies: o.replies }), tone: "warn" };
      if (o.kind === "waiting") return { text: o.reason === "fork" ? t.t("attend.fork", ref(e)) : o.reason === "busy" ? t.t("attend.busy", ref(e)) : t.t("attend.settling", ref(e)), tone: "neutral" };
      if (o.kind === "stale") return { text: t.t("attend.stale", { id: `f${o.attendId}` }), tone: "warn" };
      if (o.kind === "harness") return { text: t.t("web.log.noHarness", ref(e)), tone: "bad" };
      return { text: t.t("attend.failed", { ...ref(e), error: String(o.error ?? "").split("\n")[0]!.slice(0, 200) }), tone: "bad" };
    }
    default:
      return { text: JSON.stringify(e), tone: "neutral" };
  }
}
