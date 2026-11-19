import { mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import {
  applyVerifier,
  checkEvidence,
  decideVerdict,
  dedupeAgainstThreads,
  dedupeFindings,
  extractJson,
  mapLimit,
  newNonce,
  parseLensOutput,
  parseVerifierOutput,
  severityRank,
  type CiState,
  type ExistingComment,
  type Finding,
  type LensResult,
  type Usage,
  type Verdict,
  type VerdictPolicy,
} from "@crewreview/core";
import type { FailureKind, Harness, HarnessEvent } from "@crewreview/harness";
import { defaultConcurrency, type Config } from "./config.ts";
import { buildContext, treeOracle, type ChangeContext } from "./context.ts";
import type { Lens } from "./lenses.ts";
import { lensPrompt, PROMPT_VERSION, verifierPrompt } from "./prompts.ts";

export type ReviewEvent =
  | { type: "context"; context: ChangeContext }
  | { type: "lens-start"; lens: string; harness: string }
  | { type: "agent"; role: string; event: HarnessEvent }
  | { type: "lens-done"; result: LensResult }
  | { type: "verifier-start"; harness: string }
  | { type: "verifier-done"; ok: boolean; dropped: number; downgraded: number; error?: string };

export interface ReviewTarget {
  root: string;
  branch: string;
  base: string;
  baseSha: string;
  headSha: string;
  rulesRef: string;
  ci: CiState;
}

export interface ReviewOptions {
  target: ReviewTarget;
  jobDir: string;
  lenses: Lens[];
  /** True when the user picked a subset of lenses. */
  partial: boolean;
  harness: Harness;
  verifier?: Harness;
  config: Config;
  /** English name of the language findings are written in. */
  language: string;
  policy: VerdictPolicy;
  /** Comments already on the pull request: a finding they cover isn't raised again. */
  existingComments?: ExistingComment[];
  /** More files for ./ctx/. */
  extraContext?: Record<string, string>;
  /** Head of the previous review, when this one looks at what changed since. */
  deltaFrom?: string;
  signal?: AbortSignal;
  onEvent?: (e: ReviewEvent) => void;
}

export interface VerifierSummary {
  ran: boolean;
  harness?: string;
  ok?: boolean;
  dropped: Finding[];
  downgraded: number;
  error?: string;
  durationMs?: number;
  usage?: Usage;
}

export function sortFindings(list: readonly Finding[]): Finding[] {
  return [...list].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line,
  );
}

export interface ReviewReport {
  version: string;
  promptVersion: string;
  startedAt: string;
  finishedAt: string;
  target: Omit<ReviewTarget, "root"> & { mergeBaseSha: string };
  files: { path: string; status: string; additions: number; deletions: number }[];
  changedLines: number;
  commits: string[];
  guidelines: string[];
  lenses: LensResult[];
  findings: Finding[];
  droppedByEvidence: number;
  /** Findings left out because the existing discussion already covers them (they still count in the verdict). */
  coveredByThreads: number;
  repeated: Finding[];
  /** Head of the previous review, when ./ctx/delta.patch shows what changed since. */
  delta?: string;
  verifier: VerifierSummary;
  verdict: Verdict;
  usage: Usage;
  jobDir: string;
}

export class ReviewError extends Error {
  constructor(
    readonly code: "no-changes" | "diff-too-large" | "all-lenses-failed",
    readonly details: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

function sumUsage(list: (Usage | undefined)[]): Usage {
  const out: Usage = {};
  for (const u of list) {
    if (!u) continue;
    if (u.inputTokens !== undefined) out.inputTokens = (out.inputTokens ?? 0) + u.inputTokens;
    if (u.outputTokens !== undefined) out.outputTokens = (out.outputTokens ?? 0) + u.outputTokens;
    if (u.costUsd !== undefined) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  return out;
}

function failedLens(lens: string, harness: string, durationMs: number, failure: FailureKind | "parse", error?: string, usage?: Usage): LensResult {
  return { lens, harness, status: "failed", findings: [], coverage: "partial", uncovered: [], durationMs, error: error ? `${failure}: ${error}` : failure, usage };
}

/** One review: context → lenses in parallel → evidence → dedupe → verifier → verdict. */
export async function runReview(o: ReviewOptions, version: string): Promise<ReviewReport> {
  const startedAt = new Date().toISOString();
  await mkdir(o.jobDir, { recursive: true });
  const ctx = await buildContext({ ...o.target, jobDir: o.jobDir, extraContext: o.extraContext });
  o.onEvent?.({ type: "context", context: ctx });
  if (ctx.files.length === 0) throw new ReviewError("no-changes", { base: o.target.base, head: o.target.branch });
  if (ctx.changedLines > o.config.limits.maxDiffLines) {
    throw new ReviewError("diff-too-large", { lines: ctx.changedLines, limit: o.config.limits.maxDiffLines });
  }

  const lenses = o.partial ? o.lenses : o.lenses.filter((l) => l.applies(ctx.files));
  const nonce = newNonce();
  const promptCtx = { language: o.language, nonce };
  const oracle = treeOracle(ctx.headDir);
  const concurrency = o.config.limits.maxConcurrentAgents ?? defaultConcurrency(cpus().length);
  const run = { cwd: o.jobDir, access: "read" as const, timeoutMs: o.config.limits.agentTimeout, stallMs: o.config.limits.stallTimeout, signal: o.signal };
  const settingsOf = (h: Harness) => (o.config.harness as Record<string, { model?: string; effort?: string } | undefined>)[h.id] ?? {};

  let droppedByEvidence = 0;
  const settled = await mapLimit(lenses, concurrency, async (lens): Promise<LensResult> => {
    o.onEvent?.({ type: "lens-start", lens: lens.id, harness: o.harness.id });
    const s = settingsOf(o.harness);
    const r = await o.harness.run({
      ...run,
      prompt: lensPrompt(lens, promptCtx),
      model: s.model,
      effort: s.effort,
      onEvent: (event) => o.onEvent?.({ type: "agent", role: lens.id, event }),
    });
    if (!r.ok) return failedLens(lens.id, o.harness.id, r.durationMs, r.failure ?? "crash", r.error, r.usage);
    const parsed = parseLensOutput(extractJson(r.text));
    if (!parsed) return failedLens(lens.id, o.harness.id, r.durationMs, "parse", r.text.slice(0, 300), r.usage);
    const raw: Finding[] = parsed.findings.map((f, i) => ({ ...f, id: `${lens.id}-${i}`, lens: lens.id, lenses: [lens.id] }));
    const ev = checkEvidence(raw, oracle);
    droppedByEvidence += ev.dropped.length;
    return {
      lens: lens.id,
      harness: o.harness.id,
      status: ev.hallucinated ? "hallucinated" : "ok",
      findings: ev.kept,
      coverage: parsed.coverage,
      uncovered: parsed.uncovered,
      durationMs: r.durationMs,
      usage: r.usage,
    };
  });

  const results: LensResult[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : failedLens(lenses[i]!.id, o.harness.id, 0, "crash", String(s.reason)),
  );
  for (const r of results) o.onEvent?.({ type: "lens-done", result: r });
  if (results.length > 0 && results.every((r) => r.status === "failed")) throw new ReviewError("all-lenses-failed");

  // Ids are stable across the whole review: F1 is the most severe before verification.
  let findings = sortFindings(dedupeFindings(results.flatMap((r) => r.findings))).map((f, i) => ({ ...f, id: `F${i + 1}` }));

  const verifier: VerifierSummary = { ran: false, dropped: [], downgraded: 0 };
  const verifierHarness = o.verifier ?? o.harness;
  if (o.config.review.verifier && findings.length > 0) {
    verifier.harness = verifierHarness.id;
    o.onEvent?.({ type: "verifier-start", harness: verifierHarness.id });
    await writeFile(
      join(ctx.ctxDir, "findings.json"),
      JSON.stringify(findings.map(({ id, path, line, endLine, severity, title, body, evidence, lenses: l }) => ({ id, path, line, endLine, severity, title, body, evidence, lenses: l })), null, 2),
    );
    const s = settingsOf(verifierHarness);
    const r = await verifierHarness.run({
      ...run,
      prompt: verifierPrompt(promptCtx),
      model: s.model,
      effort: s.effort,
      onEvent: (event) => o.onEvent?.({ type: "agent", role: "verifier", event }),
    });
    verifier.durationMs = r.durationMs;
    const decisions = r.ok ? parseVerifierOutput(extractJson(r.text)) : undefined;
    if (decisions) {
      const applied = applyVerifier(findings, decisions);
      verifier.ran = true;
      verifier.ok = true;
      verifier.dropped = applied.dropped;
      verifier.downgraded = applied.kept.filter((f) => f.verification?.action === "downgrade").length;
      findings = applied.kept;
    } else {
      verifier.ok = false;
      verifier.error = r.ok ? "parse: the answer wasn't valid JSON" : `${r.failure}: ${r.error}`;
    }
    verifier.usage = r.usage;
    o.onEvent?.({ type: "verifier-done", ok: verifier.ok, dropped: verifier.dropped.length, downgraded: verifier.downgraded, error: verifier.error });
  } else if (o.config.review.verifier && findings.length === 0) {
    // Nothing to verify counts as verified: there is no claim to check.
    verifier.ran = true;
    verifier.ok = true;
  }

  // Findings the discussion already covers aren't posted again, but they still count: a blocker that's still in
  // the code keeps blocking, whether or not it was said before.
  let repeated: Finding[] = [];
  if (o.existingComments?.length) {
    const d = dedupeAgainstThreads(findings, o.existingComments);
    repeated = sortFindings(d.covered.map((c) => c.finding));
    findings = d.fresh;
  }
  findings = sortFindings(findings);
  const verdict = decideVerdict(
    { findings: [...findings, ...repeated], lenses: results, ci: o.target.ci, changedLines: ctx.changedLines, verifierRan: verifier.ran, partial: o.partial },
    o.policy,
  );

  const report: ReviewReport = {
    version,
    promptVersion: PROMPT_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: {
      branch: o.target.branch,
      base: o.target.base,
      baseSha: o.target.baseSha,
      headSha: o.target.headSha,
      rulesRef: o.target.rulesRef,
      ci: o.target.ci,
      mergeBaseSha: ctx.mergeBaseSha,
    },
    files: ctx.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    changedLines: ctx.changedLines,
    commits: ctx.commits,
    guidelines: ctx.guidelines,
    lenses: results,
    findings,
    droppedByEvidence,
    coveredByThreads: repeated.length,
    repeated,
    delta: o.deltaFrom,
    verifier,
    verdict,
    usage: sumUsage([...results.map((r) => r.usage), verifier.usage]),
    jobDir: o.jobDir,
  };
  await writeFile(join(o.jobDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
