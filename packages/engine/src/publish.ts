import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  countChecks,
  makeMarker,
  parseMarker,
  parseUnifiedDiff,
  planPost,
  splitInline,
  unreviewedFiles,
  type Finding,
  type LeftOut,
  type Severity,
  type SeverityStyle,
} from "@crewreview/core";
import type { InlineComment, PostReviewInput, Thread } from "@crewreview/hosts";
import type { Translator } from "@crewreview/i18n";
import type { ReviewReport } from "./review.ts";
import { crewreviewLink } from "@crewreview/core";

const ICONS: Record<SeverityStyle, Record<Severity, string>> = {
  crewreview: { blocker: "🔴", major: "🟠", minor: "🟡", nit: "⚪" },
  // ⛔ blocks, ⚠ is worth fixing, 💅 is polish.
  signs: { blocker: "⛔", major: "⚠️", minor: "⚠️", nit: "💅" },
};

export interface PostStyle {
  severityStyle: SeverityStyle;
  /** At most this many nits go inline; the rest are listed in the summary, in one place. */
  maxNits: number;
}

const DEFAULT_STYLE: PostStyle = { severityStyle: "crewreview", maxNits: Number.POSITIVE_INFINITY };

/** Model text shown as prose inside the fold: no HTML, so it can't close the fold or open another one. */
function prose(s: string): string {
  return s.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A code block the quoted text can't end early: the fence is longer than any run of backticks in it. */
function codeBlock(s: string): string[] {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence, s.replace(/^\n+/, "").trimEnd(), fence];
}

/**
 * Why a finding was flagged, folded under its statement: the scenario, the code it points at, and what the verifier
 * said when it checked it. Empty when there is nothing to show, so a plain finding stays one short comment.
 */
export function whyFlagged(f: Finding, t: Translator): string[] {
  const parts: string[][] = [];
  if (f.scenario?.trim()) parts.push([`**${t.t("post.scenario")}** ${prose(f.scenario)}`]);
  if (f.evidence?.trim()) parts.push([`**${t.t("post.evidence")}**`, "", ...codeBlock(f.evidence)]);
  const v = f.verification;
  const reason = v?.reason?.trim() ? prose(v.reason) : "";
  if (v && reason) {
    const from = v.from ? t.t(`severity.${v.from}`) : "";
    if (v.action === "confirm") parts.push([t.t("post.verifier.confirm", { reason })]);
    if (v.action === "downgrade" && from) parts.push([t.t("post.verifier.downgrade", { from, reason })]);
    if (v.action === "upgrade" && from) parts.push([t.t("post.verifier.upgrade", { from, place: `\`${(v.evidence ?? "").replace(/`/g, "")}\``, reason })]);
  }
  if (!parts.length) return [];
  return [`<details><summary>${t.t("post.whyFlagged")}</summary>`, "", ...parts.flatMap((p, i) => (i ? ["", ...p] : p)), "", "</details>"];
}

/** One summary entry: the statement and, folded, why it was flagged, indented to sit inside the list item. */
function summaryEntry(f: Finding, t: Translator, ICON: Record<Severity, string>): string[] {
  const why = whyFlagged(f, t);
  const inner = [f.body.trim(), ...(why.length ? ["", ...why] : [])].join("\n").split("\n");
  return [`- ${ICON[f.severity]} \`${f.path}:${f.line}\` **${f.title}**`, "", ...inner.map((l) => (l ? `  ${l}` : l)), ""];
}

/** What a review didn't comment on and why, one line per reason; core decides and counts. */
export function leftOutLine(l: LeftOut, t: Translator): string {
  switch (l.reason) {
    case "already-raised": {
      const severities = (l.severities ?? []).map((s) => `${s.count} ${t.t(`severity.${s.severity}`)}`).join(", ");
      return t.tp("post.notRepeated", l.count, { severities });
    }
    case "over-nit-cap":
      return t.tp("post.overNitCap", l.count, { cap: l.cap ?? 0 });
    case "no-evidence":
      return t.tp("post.droppedNoEvidence", l.count);
    case "unread":
      return t.tp("post.droppedUnread", l.count);
    case "verifier":
      return t.tp("post.droppedByVerifier", l.count);
  }
}

function findingBody(f: Finding, t: Translator, version: string, headSha: string, ICON: Record<Severity, string>): string {
  // The statement stays on top and short; the reasoning folds below it.
  const lines = [`${ICON[f.severity]} **${t.t(`severity.${f.severity}`)}** · ${f.lenses.join(", ")} — **${f.title}**`, "", f.body.trim()];
  const why = whyFlagged(f, t);
  if (why.length) lines.push("", ...why);
  if (f.suggestion?.trim()) lines.push("", `<details><summary>${t.t("post.suggestion")}</summary>`, "", "```", f.suggestion.trim(), "```", "", "</details>");
  const meta = [t.t(`confidence.${f.confidence}`)];
  if (f.verification?.action === "confirm") meta.push(t.t("post.verified"));
  if (f.verification?.action === "downgrade" && f.verification.from) meta.push(t.t("post.downgraded", { from: t.t(`severity.${f.verification.from}`) }));
  if (f.capped) meta.push(t.t("post.noScenario", { from: t.t(`severity.${f.capped.from}`) }));
  if (f.verification?.action === "upgrade" && f.verification.from) meta.push(t.t("post.upgraded", { from: t.t(`severity.${f.verification.from}`), place: f.verification.evidence ?? "" }));
  const crewreview = crewreviewLink("github");
  lines.push("", `<sub>${crewreview} · ${meta.join(" · ")}</sub>`, makeMarker({ kind: "finding", ref: `${f.id}@${headSha.slice(0, 12)}`, version }));
  return lines.join("\n");
}

export interface RenderedReview extends PostReviewInput {
  outside: Finding[];
}

/**
 * Turn a report into what gets posted: one summary and inline comments on lines the diff shows. The version is the
 * one that ran the review, not the one posting it: posting the same report twice renders the same text, which is how
 * a retry tells what it already posted.
 */
export async function renderHostReview(report: ReviewReport, t: Translator, fallbackVersion: string, style: PostStyle = DEFAULT_STYLE): Promise<RenderedReview> {
  const version = report.version || fallbackVersion;
  const ICON = ICONS[style.severityStyle];
  const diff = parseUnifiedDiff(await readFile(join(report.jobDir, "ctx", "diff.patch"), "utf8"));
  const lines = new Map(diff.map((f) => [f.path, f.rightLines]));
  const files = new Map(diff.map((f) => [f.path, f]));
  // Decided in core: what gets its own comment, what is asked, what is only listed, and what is left out and why.
  const { posted, unconfirmed, extraNits, stillOpen, leftOut } = planPost({
    findings: report.findings,
    repeated: report.repeated ?? [],
    maxNits: style.maxNits,
    verifierDropped: report.verifier.dropped.length,
    droppedByEvidence: report.droppedByEvidence ?? 0,
    droppedUnread: report.droppedUnread ?? 0,
  });
  const { inline, outside } = splitInline(posted, (p) => lines.get(p));
  const head = report.target.headSha;

  const counts = (Object.keys(report.verdict.counts) as Severity[])
    .filter((s) => report.verdict.counts[s] > 0)
    .map((s) => `${ICON[s]} ${t.t(`severity.${s}`)}: ${report.verdict.counts[s]}`);
  const body: string[] = [`### Crewreview · ${t.t(`verdict.${report.verdict.event}`)}`, ""];
  // The seal first: whether someone can rely on this review, and why, decided by code.
  if (report.trust) {
    body.push(`**${t.t(`trust.${report.trust.level}`)}** · ${t.t("trust.reviewedUpTo", { sha: `\`${head.slice(0, 7)}\`` })}`);
    if (report.trust.reasons.length) body.push(t.t("trust.because", { reasons: report.trust.reasons.map((r) => t.t(`trust.reason.${r}`)).join("; ") }));
    body.push("");
  }
  body.push(
    counts.length ? counts.join(" · ") : t.t("post.noFindings"),
    "",
    t.t("post.why", { reasons: report.verdict.reasons.map((r) => t.t(`reason.${r}`)).join("; ") }),
  );
  if (report.delta) body.push("", t.t("post.delta", { sha: report.delta.slice(0, 7) }));
  const notes: string[] = [];
  const uncovered = unreviewedFiles(report.lenses);
  if (uncovered.length) notes.push(t.t("post.notCovered", { files: uncovered.map((f) => `\`${f}\``).join(", ") }));
  if (report.reviewGuide) notes.push(t.t("post.reviewGuide", { file: `\`${report.reviewGuide}\`` }));
  if (report.guidelinesCut?.length) notes.push(t.t("post.guidelinesCut", { files: report.guidelinesCut.map((f) => `\`${f}\``).join(", ") }));
  const minified = (report.omitted ?? []).filter((f) => f.reason === "minified");
  const cut = (report.omitted ?? []).filter((f) => f.reason === "cut");
  if (minified.length) notes.push(t.t("post.leftOut", { files: minified.map((f) => `\`${f.path}\``).join(", ") }));
  if (cut.length) notes.push(t.t("post.cut", { files: cut.map((f) => `\`${f.path}\``).join(", ") }));
  // A re-review that finds less because it doesn't repeat itself says so: how many, and why.
  for (const l of leftOut) notes.push(leftOutLine(l, t));
  const failed = report.lenses.filter((l) => l.status !== "ok").map((l) => l.lens);
  if (failed.length) notes.push(t.t("post.lensesFailed", { lenses: failed.join(", ") }));
  if (notes.length) body.push("", ...notes.map((n) => `- ${n}`));
  if (stillOpen.length) {
    body.push("", `#### ${t.t("post.stillOpen")}`, "");
    for (const f of stillOpen) body.push(`- ${ICON[f.severity]} \`${f.path}:${f.line}\` ${f.title}`);
  }
  if (unconfirmed.length) {
    body.push("", `#### ${t.t("post.unconfirmed")}`, "");
    for (const f of unconfirmed) body.push(...summaryEntry(f, t, ICON));
  }
  if (report.checks?.length) {
    // Counted by code, failures first: the model only says what it checked and where.
    const n = countChecks(report.checks);
    const order = { fails: 0, unverified: 1, holds: 2 } as const;
    const mark = { holds: "✅", fails: "❌", unverified: "❔" } as const;
    body.push("", `<details><summary>${t.t("post.checks", n)}</summary>`, "");
    for (const c of [...report.checks].sort((a, b) => order[a.status] - order[b.status])) {
      const where = c.evidence && !c.unproven ? ` · \`${c.evidence.replace(/`/g, "").trim()}\`` : c.unproven ? ` · ${t.t("post.check.unproven")}` : "";
      const from = c.source ? ` (${t.t(`post.check.${c.kind}`)}, ${c.source.replace(/[`<>]/g, "")})` : ` (${t.t(`post.check.${c.kind}`)})`;
      body.push(`- ${mark[c.status]} ${c.text.replace(/[<>]/g, "")}${from}${where}`);
    }
    body.push("", "</details>");
  }
  if (extraNits.length) {
    body.push("", `<details><summary>${t.tp("post.moreNits", extraNits.length)}</summary>`, "");
    for (const f of extraNits) body.push(`- ${ICON.nit} \`${f.path}:${f.line}\` ${f.title}`);
    body.push("", "</details>");
  }
  if (outside.length) {
    body.push("", `#### ${t.t("post.outsideDiff")}`, "");
    for (const f of outside) body.push(...summaryEntry(f, t, ICON));
  }
  const harness = report.lenses[0]?.harness ?? "?";
  const verifier = report.verifier.harness && report.verifier.harness !== harness ? ` · ${t.t("post.verifiedBy", { harness: report.verifier.harness })}` : "";
  const crewreview = crewreviewLink("github");
  body.push("", `<sub>${t.t("post.footer", { crewreview, version, harness: `${harness}${verifier}`, prompt: report.promptVersion, sha: head.slice(0, 7) })}</sub>`);
  body.push(makeMarker({ kind: "review", ref: head, version }));

  const comments: InlineComment[] = inline.map((f) => {
    const file = files.get(f.path);
    const oldLine = file?.contextOld.get(f.line);
    return { path: f.path, line: f.line, body: findingBody(f, t, version, head, ICON), ...(file?.oldPath ? { oldPath: file.oldPath } : {}), ...(oldLine ? { oldLine } : {}) };
  });
  return { headSha: head, event: report.verdict.event, body: body.join("\n"), comments, fallbackHeading: t.t("post.outsideDiff"), outside };
}

/** The heads Crewreview already reviewed on the host, read from its own hidden markers. */
export function reviewedHeadsOnHost(threads: readonly Thread[], reviewBodies: readonly string[]): Set<string> {
  const out = new Set<string>();
  const scan = (body: string) => {
    const m = parseMarker(body);
    if (m?.kind === "review" && m.ref) out.add(m.ref);
  };
  for (const th of threads) for (const c of th.comments) scan(c.body);
  for (const b of reviewBodies) scan(b);
  return out;
}
