import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeMarker, parseMarker, parseUnifiedDiff, splitInline, unreviewedFiles, type Finding, type Severity, type SeverityStyle } from "@crewreview/core";
import type { InlineComment, PostReviewInput, Thread } from "@crewreview/hosts";
import type { Translator } from "@crewreview/i18n";
import type { ReviewReport } from "./review.ts";

const ICONS: Record<SeverityStyle, Record<Severity, string>> = {
  crewreview: { blocker: "🔴", major: "🟠", minor: "🟡", nit: "⚪" },
  // ⛔ blocks, ⚠ is worth fixing, 💅 is polish.
  tupi: { blocker: "⛔", major: "⚠️", minor: "⚠️", nit: "💅" },
};

export interface PostStyle {
  severityStyle: SeverityStyle;
  /** At most this many nits go inline; the rest are listed in the summary, in one place. */
  maxNits: number;
}

const DEFAULT_STYLE: PostStyle = { severityStyle: "crewreview", maxNits: Number.POSITIVE_INFINITY };

function findingBody(f: Finding, t: Translator, version: string, headSha: string, ICON: Record<Severity, string>): string {
  const lines = [`${ICON[f.severity]} **${t.t(`severity.${f.severity}`)}** · ${f.lenses.join(", ")} — **${f.title}**`, "", f.body.trim()];
  if (f.suggestion?.trim()) lines.push("", `<details><summary>${t.t("post.suggestion")}</summary>`, "", "```", f.suggestion.trim(), "```", "", "</details>");
  const meta = [t.t(`confidence.${f.confidence}`)];
  if (f.verification?.action === "confirm") meta.push(t.t("post.verified"));
  if (f.verification?.action === "downgrade" && f.verification.from) meta.push(t.t("post.downgraded", { from: t.t(`severity.${f.verification.from}`) }));
  if (f.verification?.action === "upgrade" && f.verification.from) meta.push(t.t("post.upgraded", { from: t.t(`severity.${f.verification.from}`), place: f.verification.evidence ?? "" }));
  lines.push("", `<sub>Crewreview · ${meta.join(" · ")}</sub>`, makeMarker({ kind: "finding", ref: `${f.id}@${headSha.slice(0, 12)}`, version }));
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
  // Past the cap, nits are listed once in the summary instead of each getting a comment: they're the noise.
  const nits = report.findings.filter((f) => f.severity === "nit");
  const extraNits = nits.slice(style.maxNits);
  const posted = report.findings.filter((f) => !extraNits.includes(f));
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
  if (report.guidelinesCut?.length) notes.push(t.t("post.guidelinesCut", { files: report.guidelinesCut.map((f) => `\`${f}\``).join(", ") }));
  const minified = (report.omitted ?? []).filter((f) => f.reason === "minified");
  const cut = (report.omitted ?? []).filter((f) => f.reason === "cut");
  if (minified.length) notes.push(t.t("post.leftOut", { files: minified.map((f) => `\`${f.path}\``).join(", ") }));
  if (cut.length) notes.push(t.t("post.cut", { files: cut.map((f) => `\`${f.path}\``).join(", ") }));
  if (report.verifier.dropped.length) notes.push(t.tp("post.droppedByVerifier", report.verifier.dropped.length));
  if (report.coveredByThreads) notes.push(t.tp("post.alreadyDiscussed", report.coveredByThreads));
  const failed = report.lenses.filter((l) => l.status !== "ok").map((l) => l.lens);
  if (failed.length) notes.push(t.t("post.lensesFailed", { lenses: failed.join(", ") }));
  if (notes.length) body.push("", ...notes.map((n) => `- ${n}`));
  const still = (report.repeated ?? []).filter((f) => f.severity === "blocker" || f.severity === "major");
  if (still.length) {
    body.push("", `#### ${t.t("post.stillOpen")}`, "");
    for (const f of still) body.push(`- ${ICON[f.severity]} \`${f.path}:${f.line}\` ${f.title}`);
  }
  if (extraNits.length) {
    body.push("", `<details><summary>${t.tp("post.moreNits", extraNits.length)}</summary>`, "");
    for (const f of extraNits) body.push(`- ${ICON.nit} \`${f.path}:${f.line}\` ${f.title}`);
    body.push("", "</details>");
  }
  if (outside.length) {
    body.push("", `#### ${t.t("post.outsideDiff")}`, "");
    for (const f of outside) body.push(`- ${ICON[f.severity]} \`${f.path}:${f.line}\` **${f.title}**`, "", f.body.trim().replace(/^/gm, "  "), "");
  }
  const harness = report.lenses[0]?.harness ?? "?";
  const verifier = report.verifier.harness && report.verifier.harness !== harness ? ` · ${t.t("post.verifiedBy", { harness: report.verifier.harness })}` : "";
  body.push("", `<sub>${t.t("post.footer", { version, harness: `${harness}${verifier}`, prompt: report.promptVersion, sha: head.slice(0, 7) })}</sub>`);
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
