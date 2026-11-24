import { mkdir, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import {
  applyVerifier,
  unreadFindings,
  requireScenario,
  checkEvidence,
  decideVerdict,
  settleChecks,
  trustLevel,
  type Check,
  type Trust,
  dedupeAgainstThreads,
  dedupeFindings,
  extractJson,
  mapLimit,
  newNonce,
  normalizeRepoPath,
  parseLensOutput,
  parseVerifierOutput,
  severityRank,
  totalChangedLines,
  type CiState,
  type ExistingComment,
  type Finding,
  type LensResult,
  type OmittedFile,
  type Usage,
  type Verdict,
  type VerdictPolicy,
} from "@crewreview/core";
import type { FailureKind, Harness, HarnessEvent } from "@crewreview/harness";
import { defaultConcurrency, type Config } from "./config.ts";
import { buildContext, treeOracle, type ChangeContext } from "./context.ts";
import type { Lens } from "./lenses.ts";
import { isPickError } from "./harnesses.ts";
import { lensPrompt, PROMPT_VERSION, verifierPrompt } from "./prompts.ts";
import { fixedSeat, type SeatChoice, type SeatPicker } from "./seats.ts";

/** How many seats one lens or the verifier tries when each hits its usage limit. */
const MAX_SEAT_TRIES = 4;
/** Failures worth one more run: not a login, a usage limit or a harness that can't do the job. */
const RETRYABLE = /^(timeout|stalled|crash|parse)\b/;

export type ReviewEvent =
  | { type: "context"; context: ChangeContext }
  | { type: "lens-start"; lens: string; harness: string; seat?: string }
  | { type: "agent"; role: string; event: HarnessEvent }
  | { type: "lens-done"; result: LensResult }
  | { type: "verifier-start"; harness: string; seat?: string }
  | { type: "verifier-done"; ok: boolean; dropped: number; downgraded: number; error?: string }
  | { type: "attendant-start"; harness: string; seat?: string }
  | { type: "attendant-done"; ok: boolean; error?: string };

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
  /**
   * Seats for the lenses and the verifier, when [roles] routes them (docs/plans/crew-mode.md): each run takes a seat,
   * and a run that hits its usage limit goes on the next seat. Unset: every lens on `harness`, the verifier on
   * `verifier`.
   */
  lensSeats?: SeatPicker;
  verifySeats?: SeatPicker;
  config: Config;
  /** English name of the language findings are written in. */
  language: string;
  policy: VerdictPolicy;
  /** Comments already on the pull request: a finding they cover isn't raised again. */
  existingComments?: ExistingComment[];
  /** More files for ./ctx/. */
  extraContext?: Record<string, string>;
  /** More project rules to read, besides the usual files: paths in the repository, a folder gives its .md files. */
  guidelines?: readonly string[];
  /** Head of the previous review, when this one looks at what changed since. */
  deltaFrom?: string;
  signal?: AbortSignal;
  onEvent?: (e: ReviewEvent) => void;
}

export interface VerifierSummary {
  ran: boolean;
  harness?: string;
  /** The seat that ran it, when [roles] routes the verifier. */
  seat?: string;
  model?: string;
  ok?: boolean;
  dropped: Finding[];
  downgraded: number;
  /** Raised with a place that shows the impact. */
  upgraded?: number;
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
  /** Changed files the agents didn't get the diff of: minified, generated or too large. */
  omitted?: OmittedFile[];
  commits: string[];
  guidelines: string[];
  /** Project rules read only in part: too long, or past the room for all of them. */
  guidelinesCut?: string[];
  /** The team's review guidance the crew followed (REVIEW.md), read from the rules ref. */
  reviewGuide?: string;
  lenses: LensResult[];
  findings: Finding[];
  droppedByEvidence: number;
  /** Findings on files their own lens said it couldn't review. */
  droppedUnread?: number;
  /** Findings left out because the existing discussion already covers them (they still count in the verdict). */
  coveredByThreads: number;
  repeated: Finding[];
  /** Head of the previous review, when ./ctx/delta.patch shows what changed since. */
  delta?: string;
  verifier: VerifierSummary;
  verdict: Verdict;
  /** How far the review can be trusted (trustLevel): shown at the top of what's posted. */
  trust?: Trust;
  /** Claims and project rules the review checked against the code. */
  checks?: Check[];
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
  const ctx = await buildContext({ ...o.target, jobDir: o.jobDir, extraContext: o.extraContext, guidelines: o.guidelines });
  o.onEvent?.({ type: "context", context: ctx });
  if (ctx.files.length === 0) throw new ReviewError("no-changes", { base: o.target.base, head: o.target.branch });
  // Lines of files left out of the diff (a bundle, a generated file) aren't read, so they don't count.
  // Only minified or generated files are out of scope: a cut file is still to be reviewed, from ./head/.
  const leftOut = new Set(ctx.omitted.filter((f) => f.reason === "minified").map((f) => f.path));
  const reviewedLines = totalChangedLines(ctx.files.filter((f) => !leftOut.has(f.path)));
  if (reviewedLines > o.config.limits.maxDiffLines) {
    throw new ReviewError("diff-too-large", { lines: reviewedLines, limit: o.config.limits.maxDiffLines });
  }

  const lenses = o.partial ? o.lenses : o.lenses.filter((l) => l.applies(ctx.files));
  const nonce = newNonce();
  const promptCtx = { language: o.language, nonce, ...(ctx.reviewGuide ? { reviewGuide: ctx.reviewGuide } : {}) };
  const oracle = treeOracle(ctx.headDir);
  const concurrency = o.config.limits.maxConcurrentAgents ?? defaultConcurrency(cpus().length);
  const run = { cwd: o.jobDir, access: "read" as const, timeoutMs: o.config.limits.agentTimeout, stallMs: o.config.limits.stallTimeout, signal: o.signal };
  const lensSeats = o.lensSeats ?? fixedSeat(o.harness, o.config);
  const verifySeats = o.verifySeats ?? fixedSeat(o.verifier ?? o.harness, o.config);
  const routed = (c: SeatChoice, routedHere: boolean) => (routedHere ? { seat: c.seat, ...(c.model ? { model: c.model } : {}) } : {});

  let droppedByEvidence = 0;
  let droppedUnread = 0;
  // What each agent answered, kept beside the report so a bad review can be looked into afterwards.
  const transcripts = new Map<string, string>();
  const settled = await mapLimit(lenses, concurrency, async (lens): Promise<LensResult> => {
    const tried: string[] = [];
    let limited: LensResult | undefined;
    let retried = false;
    for (let attempt = 0; attempt < MAX_SEAT_TRIES; attempt++) {
      const c = await lensSeats(tried);
      // No seat left: the run that hit its limit says why; a pick that found none at all says that.
      if (isPickError(c)) return limited ?? failedLens(lens.id, o.harness.id, 0, "unsupported", `no seat: ${c.error}`);
      tried.push(c.seat);
      const seat = routed(c, !!o.lensSeats);
      o.onEvent?.({ type: "lens-start", lens: lens.id, harness: c.harness.id, ...seat });
      const r = await c.harness
        .run({ ...run, prompt: lensPrompt(lens, promptCtx), model: c.model, effort: c.effort, onEvent: (event) => o.onEvent?.({ type: "agent", role: lens.id, event }) })
        .finally(() => c.done());
      if (!r.ok && r.failure === "quota" && o.lensSeats) {
        c.limit(r.error ?? "quota");
        limited = { ...failedLens(lens.id, c.harness.id, r.durationMs, "quota", r.error, r.usage), ...seat };
        continue;
      }
      const result = lensResult(lens.id, c, seat, r);
      // A lens that timed out, stalled, crashed or answered garbage gets one more run on the same seat: a review with
      // a lens missing can't be trusted, and these failures are often passing.
      if (result.status === "failed" && !retried && RETRYABLE.test(result.error ?? "") && !o.signal?.aborted) {
        retried = true;
        tried.pop();
        continue;
      }
      return result;
    }
    return limited ?? failedLens(lens.id, o.harness.id, 0, "quota");
  });

  function lensResult(lensId: string, c: SeatChoice, seat: { seat?: string; model?: string }, r: Awaited<ReturnType<Harness["run"]>>): LensResult {
    const lens = { id: lensId };
    if (r.text) transcripts.set(lensId, r.text);
    if (!r.ok) return { ...failedLens(lens.id, c.harness.id, r.durationMs, r.failure ?? "crash", r.error, r.usage), ...seat };
    const parsed = parseLensOutput(extractJson(r.text));
    if (!parsed) return { ...failedLens(lens.id, c.harness.id, r.durationMs, "parse", r.text.slice(0, 300), r.usage), ...seat };
    const raw: Finding[] = parsed.findings.map((f, i) => ({ ...f, id: `${lens.id}-${i}`, lens: lens.id, lenses: [lens.id] }));
    const ev = checkEvidence(raw, oracle);
    droppedByEvidence += ev.dropped.length;
    // A file the lens never got the diff of isn't a gap in its review.
    const uncovered = parsed.uncovered.filter((p) => !leftOut.has(normalizeRepoPath(p) ?? p));
    // A lens can't speak for a file it says it didn't review: decided here, not left to the model.
    const unread = unreadFindings(requireScenario(ev.kept), parsed.uncovered);
    droppedUnread += unread.dropped;
    const coverage = parsed.coverage === "partial" && parsed.uncovered.length > 0 && uncovered.length === 0 ? "full" : parsed.coverage;
    return {
      lens: lens.id,
      harness: c.harness.id,
      status: ev.hallucinated ? "hallucinated" : "ok",
      findings: unread.kept,
      coverage,
      uncovered,
      // Said to hold or fail only with a real place: decided here, like the findings' evidence.
      ...(parsed.checks.length ? { checks: settleChecks(parsed.checks, oracle) } : {}),
      durationMs: r.durationMs,
      usage: r.usage,
      ...seat,
    };
  }

  const results: LensResult[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : failedLens(lenses[i]!.id, o.harness.id, 0, "crash", String(s.reason)),
  );
  for (const r of results) o.onEvent?.({ type: "lens-done", result: r });
  if (results.length > 0 && results.every((r) => r.status === "failed")) {
    const kinds = new Set(results.map((r) => r.error?.split(":")[0] ?? "crash"));
    throw new ReviewError("all-lenses-failed", { failure: kinds.size === 1 ? [...kinds][0]! : "crash" });
  }

  // Ids are stable across the whole review: F1 is the most severe before verification.
  let findings = sortFindings(dedupeFindings(results.flatMap((r) => r.findings))).map((f, i) => ({ ...f, id: `F${i + 1}` }));

  const verifier: VerifierSummary = { ran: false, dropped: [], downgraded: 0 };
  if (o.config.review.verifier && findings.length > 0) {
    await writeFile(
      join(ctx.ctxDir, "findings.json"),
      JSON.stringify(findings.map(({ id, path, line, endLine, severity, title, body, evidence, scenario, lenses: l }) => ({ id, path, line, endLine, severity, title, body, evidence, scenario, lenses: l })), null, 2),
    );
    const tried: string[] = [];
    let ran: Awaited<ReturnType<Harness["run"]>> | undefined;
    let noSeat: string | undefined;
    for (let attempt = 0; attempt < MAX_SEAT_TRIES; attempt++) {
      const c = await verifySeats(tried);
      if (isPickError(c)) {
        noSeat = c.error;
        break;
      }
      tried.push(c.seat);
      const seat = routed(c, !!o.verifySeats);
      Object.assign(verifier, { harness: c.harness.id }, seat);
      o.onEvent?.({ type: "verifier-start", harness: c.harness.id, ...seat });
      ran = await c.harness
        .run({ ...run, prompt: verifierPrompt(promptCtx), onEvent: (event) => o.onEvent?.({ type: "agent", role: "verifier", event }), model: c.model, effort: c.effort })
        .finally(() => c.done());
      if (!ran.ok && ran.failure === "quota" && o.verifySeats) {
        c.limit(ran.error ?? "quota");
        continue;
      }
      break;
    }
    if (ran?.text) transcripts.set("verifier", ran.text);
    const r = ran ?? { ok: false as const, text: "", exitCode: null, durationMs: 0, failure: "unsupported" as const, error: `no seat: ${noSeat ?? "quota"}` };
    verifier.durationMs = r.durationMs;
    const decisions = r.ok ? parseVerifierOutput(extractJson(r.text)) : undefined;
    if (decisions) {
      // It may raise a severity only with a real place that shows the impact, and never to a blocker.
      const applied = applyVerifier(findings, decisions, { raise: o.config.review.verifierRaise, raiseTo: "major", oracle });
      verifier.ran = true;
      verifier.ok = true;
      verifier.dropped = applied.dropped;
      verifier.downgraded = applied.kept.filter((f) => f.verification?.action === "downgrade").length;
      verifier.upgraded = applied.kept.filter((f) => f.verification?.action === "upgrade").length;
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
  // Decided by code from what happened: what the review read, what ran, what's still open.
  const checks = results.flatMap((r) => r.checks ?? []);
  const trust = trustLevel({
    findings: [...findings, ...repeated],
    lenses: results,
    ci: o.target.ci,
    changedLines: ctx.changedLines,
    maxChangedLines: o.policy.approveMaxChangedLines,
    verifierRan: verifier.ran,
    partial: o.partial,
  });
  const verdict = decideVerdict(
    { findings: [...findings, ...repeated], lenses: results, ci: o.target.ci, changedLines: ctx.changedLines, verifierRan: verifier.ran, partial: o.partial, trust },
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
    ...(ctx.omitted.length ? { omitted: ctx.omitted } : {}),
    commits: ctx.commits,
    guidelines: ctx.guidelines,
    ...(ctx.guidelinesCut.length || ctx.reviewGuide?.cut ? { guidelinesCut: [...ctx.guidelinesCut, ...(ctx.reviewGuide?.cut ? [ctx.reviewGuide.path] : [])] } : {}),
    ...(ctx.reviewGuide ? { reviewGuide: ctx.reviewGuide.path } : {}),
    lenses: results,
    findings,
    droppedByEvidence,
    droppedUnread,
    ...(checks.length ? { checks } : {}),
    coveredByThreads: repeated.length,
    repeated,
    delta: o.deltaFrom,
    verifier,
    verdict,
    trust,
    usage: sumUsage([...results.map((r) => r.usage), verifier.usage]),
    jobDir: o.jobDir,
  };
  // Written last, outside ./ctx/: no agent of this review reads another's answer.
  if (transcripts.size) {
    await mkdir(join(o.jobDir, "agents"), { recursive: true });
    for (const [role, text] of transcripts) await writeFile(join(o.jobDir, "agents", `${role.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`), text);
  }
  await writeFile(join(o.jobDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
