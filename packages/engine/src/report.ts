import { countChecks, unreviewedFiles, type Finding, type LensResult, type Severity } from "@crewreview/core";
import type { Translator } from "@crewreview/i18n";
import type { ReviewReport } from "./review.ts";

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
export const ANSI_STYLE: Style = { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), yellow: wrap(33, 39), green: wrap(32, 39), cyan: wrap(36, 39) };
const id = (s: string) => s;
export const PLAIN_STYLE: Style = { bold: id, dim: id, red: id, yellow: id, green: id, cyan: id };

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`;
}

function severityStyle(s: Severity, st: Style): (x: string) => string {
  return s === "blocker" ? st.red : s === "major" ? st.yellow : s === "minor" ? st.cyan : st.dim;
}

function failureText(error: string | undefined, t: Translator): string {
  if (!error) return "";
  const kind = error.split(":")[0] ?? "";
  const known = ["timeout", "stalled", "quota", "auth", "crash", "aborted", "unsupported", "parse"];
  const label = known.includes(kind) ? t.t(`failure.${kind}` as never) : "";
  const rest = error.slice(kind.length + 1).trim().split("\n")[0]?.slice(0, 160) ?? "";
  return [label, rest].filter(Boolean).join(" — ");
}

function lensLine(r: LensResult, t: Translator, st: Style): string {
  const mark = r.status === "ok" ? st.green("✓") : r.status === "skipped" ? st.dim("–") : st.red("✗");
  const detail =
    r.status === "ok"
      ? t.tp("local.findingsCount", r.findings.length)
      : r.status === "hallucinated"
        ? t.t("status.hallucinated")
        : failureText(r.error, t) || t.t(`status.${r.status}`);
  const who = r.seat && r.seat !== r.harness ? r.seat : r.harness;
  return `  ${mark} ${r.lens.padEnd(14)} ${st.dim(who.padEnd(8))} ${st.dim(seconds(r.durationMs).padStart(6))}  ${detail}`;
}

function findingBlock(f: Finding, t: Translator, st: Style): string[] {
  const sev = severityStyle(f.severity, st)(t.t(`severity.${f.severity}`).padEnd(12));
  const where = st.bold(`${f.path}:${f.line}${f.endLine ? `-${f.endLine}` : ""}`);
  const lenses = st.dim(`[${f.lenses.join(", ")}]`);
  const out = [`  ${sev} ${where}  ${f.title} ${lenses}`];
  for (const line of f.body.trim().split("\n")) out.push(`      ${line}`);
  if (f.verification?.action === "downgrade" && f.verification.from) {
    out.push(st.dim(`      ↓ ${t.t(`severity.${f.verification.from}`)} → ${t.t(`severity.${f.severity}`)}: ${f.verification.reason}`));
  }
  if (f.verification?.action === "upgrade" && f.verification.from) {
    out.push(st.dim(`      ↑ ${t.t(`severity.${f.verification.from}`)} → ${t.t(`severity.${f.severity}`)} (${f.verification.evidence ?? ""}): ${f.verification.reason}`));
  }
  return out;
}

/** The claims and rules a review checked, failures first, one line each. */
function checkLines(r: ReviewReport, t: Translator): string[] {
  if (!r.checks?.length) return [];
  const order = { fails: 0, unverified: 1, holds: 2 } as const;
  const mark = { holds: "✓", fails: "✗", unverified: "?" } as const;
  return [...r.checks]
    .sort((a, b) => order[a.status] - order[b.status])
    .map((c) => `${mark[c.status]} ${c.text} (${t.t(`post.check.${c.kind}`)}${c.source ? `, ${c.source}` : ""})${c.evidence && !c.unproven ? ` · ${c.evidence}` : ""}`);
}

export function renderTerminal(r: ReviewReport, t: Translator, st: Style = PLAIN_STYLE, heading = t.t("local.title")): string {
  const additions = r.files.reduce((n, f) => n + f.additions, 0);
  const deletions = r.files.reduce((n, f) => n + f.deletions, 0);
  const lines: string[] = [
    st.bold(heading),
    `  ${t.t("local.summary", { branch: r.target.branch, base: r.target.base, commits: t.tp("local.commits", r.commits.length), files: t.tp("local.files", r.files.length), additions, deletions })}`,
    "",
    st.bold(t.t("local.lenses")),
    ...r.lenses.map((l) => lensLine(l, t, st)),
  ];
  const v = r.verifier;
  if (v.harness) {
    const mark = v.ok ? st.green("✓") : st.red("✗");
    const detail = v.ok ? t.t("local.verifierSummary", { dropped: v.dropped.length, downgraded: v.downgraded }) : failureText(v.error, t);
    lines.push(`  ${mark} ${t.t("local.verifier").padEnd(14)} ${st.dim(v.harness.padEnd(8))} ${st.dim(seconds(v.durationMs ?? 0).padStart(6))}  ${detail}`);
  }
  const uncovered = unreviewedFiles(r.lenses);
  if (uncovered.length) lines.push(st.dim(`  ${t.t("local.uncovered", { files: uncovered.join(", ") })}`));
  if (r.guidelinesCut?.length) lines.push(st.dim(`  ${t.t("local.guidelinesCut", { files: r.guidelinesCut.join(", ") })}`));
  if (r.omitted?.length) lines.push(st.dim(`  ${t.t("local.leftOut", { files: r.omitted.map((f) => f.path).join(", ") })}`));
  lines.push("", st.bold(`${t.t("local.findings")} (${r.findings.length})`));
  if (r.findings.length === 0) lines.push(`  ${t.t("local.noFindings")}`);
  for (const f of r.findings) lines.push(...findingBlock(f, t, st), "");
  if (r.droppedByEvidence > 0) lines.push(st.dim(`  ${t.tp("local.droppedEvidence", r.droppedByEvidence)}`));
  const checks = checkLines(r, t);
  if (checks.length) lines.push("", st.bold(t.t("post.checks", countChecks(r.checks!))), ...checks.map((l) => `  ${l}`));

  const event = t.t(`verdict.${r.verdict.event}`);
  const color = r.verdict.event === "request_changes" ? st.red : r.verdict.event === "approve" ? st.green : st.yellow;
  const reasons = r.verdict.reasons.map((x) => t.t(`reason.${x}`)).join("; ");
  lines.push("", `${st.bold(t.t("local.verdict"))}: ${color(event)} ${st.dim(`— ${reasons}`)}`);
  const tokens = (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0);
  if (tokens > 0) {
    const cost = r.usage.costUsd !== undefined ? ` · US$ ${r.usage.costUsd.toFixed(2)}` : "";
    lines.push(st.dim(t.t("local.cost", { tokens: tokens.toLocaleString(t.locale), cost })));
  }
  return lines.join("\n");
}

/** Markdown version of the report, saved next to report.json. */
export function renderMarkdown(r: ReviewReport, t: Translator): string {
  const out: string[] = [
    `# ${t.t("local.title")}`,
    "",
    `\`${r.target.branch}\` → \`${r.target.base}\` · ${r.files.length} files · ${r.changedLines} lines`,
    "",
    `**${t.t("local.verdict")}:** ${t.t(`verdict.${r.verdict.event}`)} — ${r.verdict.reasons.map((x) => t.t(`reason.${x}`)).join("; ")}`,
    "",
    `## ${t.t("local.findings")} (${r.findings.length})`,
    "",
  ];
  if (r.findings.length === 0) out.push(t.t("local.noFindings"), "");
  for (const f of r.findings) {
    out.push(`### ${t.t(`severity.${f.severity}`)} · \`${f.path}:${f.line}\` — ${f.title}`, "", f.body.trim(), "");
    if (f.suggestion) out.push("```", f.suggestion.trim(), "```", "");
    out.push(`<sub>${f.lenses.join(", ")} · ${f.confidence}${f.verification ? ` · ${f.verification.action}` : ""}</sub>`, "");
  }
  const checks = checkLines(r, t);
  if (checks.length) out.push(`## ${t.t("post.checks", countChecks(r.checks!))}`, "", ...checks.map((l) => `- ${l}`), "");
  out.push(`## ${t.t("local.lenses")}`, "", "| lens | harness | status | findings | time |", "|---|---|---|---|---|");
  for (const l of r.lenses) out.push(`| ${l.lens} | ${l.harness} | ${l.status} | ${l.findings.length} | ${seconds(l.durationMs)} |`);
  out.push("", `<sub>Crewreview ${r.version} · prompt v${r.promptVersion} · ${r.target.headSha.slice(0, 12)}</sub>`, "");
  return out.join("\n");
}
