import { z } from "zod";
import { lessSevere, SEVERITIES, type Finding, type Severity } from "./model.ts";

/**
 * A review calibration case: a real pull request pinned to the commits that were reviewed, with what a good review
 * must find and what it must not claim. Cases describe someone's code, so they live with that person (outside this
 * repository); only the scoring lives here.
 */
const Expectation = z.object({
  id: z.string().min(1),
  /** The finding must be on this file (a suffix of its path), when given. */
  file: z.string().min(1).optional(),
  /** It must mention at least one of these, ignoring case and accents. */
  any: z.array(z.string().min(1)).min(1),
  /** And, when given, one of these too: what the finding says about it, not just its name. */
  also: z.array(z.string().min(1)).min(1).optional(),
  /** Found below this severity, it counts as underrated, not found: a real risk posted as a detail gets skimmed. */
  atLeast: z.enum(SEVERITIES).optional(),
  note: z.string().optional(),
});
export type EvalExpectation = z.infer<typeof Expectation>;

const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** The linked repository (its id in repos.toml), for the mirror and the token. */
  repo: z.string().min(1),
  number: z.number().int().positive(),
  /** The pull request's address: finds it when the repository comes in through an organization or group link. */
  url: z.string().url().optional(),
  /** The commit that was reviewed. */
  head: z.string().regex(/^[0-9a-f]{7,40}$/),
  /** The merge base it was reviewed against: the base moved on since, and may contain the change by now. */
  base: z.string().regex(/^[0-9a-f]{7,40}$/),
  lenses: z.array(z.string()).optional(),
  /** The language the reviews are written in (e.g. "pt-BR"): the one the real reviews used, since the words to find are in it. */
  language: z.string().optional(),
  must: z.array(Expectation).default([]),
  mustNot: z.array(Expectation).default([]),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export function parseEvalCase(value: unknown): { ok: true; case: EvalCase } | { ok: false; error: string } {
  const r = EvalCaseSchema.safeParse(value);
  return r.success ? { ok: true, case: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "case"}: ${i.message}`).join("; ") };
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

type Scored = Pick<Finding, "path" | "title" | "body" | "severity">;

/** Does this finding say what the expectation describes: on its file, with one of its words? */
export function matchesExpectation(f: Scored, e: EvalExpectation): boolean {
  if (e.file && !fold(f.path).endsWith(fold(e.file))) return false;
  const text = fold(`${f.title}\n${f.body}`);
  const has = (words: readonly string[]) => words.some((w) => text.includes(fold(w)));
  return has(e.any) && (!e.also || has(e.also));
}

export interface EvalScore {
  id: string;
  found: string[];
  /** Said, but below the severity it deserves. */
  underrated: string[];
  missed: string[];
  /** Things it must not claim, that it claimed. */
  falsePositives: string[];
  /** Found over must; 1 when there's nothing it must find. */
  recall: number;
  findings: number;
  /** Findings by severity: the noise of a review is in its smallest ones. */
  bySeverity: Partial<Record<Severity, number>>;
}

export function scoreEval(c: EvalCase, findings: readonly Scored[]): EvalScore {
  const strong = (e: EvalExpectation, f: Scored) => !e.atLeast || !lessSevere(f.severity, e.atLeast);
  const found = c.must.filter((e) => findings.some((f) => matchesExpectation(f, e) && strong(e, f))).map((e) => e.id);
  const underrated = c.must.filter((e) => !found.includes(e.id) && findings.some((f) => matchesExpectation(f, e))).map((e) => e.id);
  const missed = c.must.filter((e) => !found.includes(e.id) && !underrated.includes(e.id)).map((e) => e.id);
  const falsePositives = c.mustNot.filter((e) => findings.some((f) => matchesExpectation(f, e))).map((e) => e.id);
  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  return { id: c.id, found, underrated, missed, falsePositives, recall: c.must.length ? found.length / c.must.length : 1, findings: findings.length, bySeverity };
}

export interface EvalSummary {
  cases: number;
  /** Over every must of every case, not an average of averages. */
  recall: number;
  /** Said, but below the severity it deserves (not in recall). */
  underrated: number;
  falsePositives: number;
  findingsPerReview: number;
  /** minor and nit findings per review. */
  smallPerReview: number;
}

export function summarizeEval(scores: readonly EvalScore[]): EvalSummary {
  const must = scores.reduce((n, s) => n + s.found.length + s.underrated.length + s.missed.length, 0);
  const found = scores.reduce((n, s) => n + s.found.length, 0);
  const per = (n: number) => (scores.length ? Math.round((n / scores.length) * 10) / 10 : 0);
  return {
    cases: scores.length,
    recall: must ? found / must : 1,
    underrated: scores.reduce((n, s) => n + s.underrated.length, 0),
    falsePositives: scores.reduce((n, s) => n + s.falsePositives.length, 0),
    findingsPerReview: per(scores.reduce((n, s) => n + s.findings, 0)),
    smallPerReview: per(scores.reduce((n, s) => n + (s.bySeverity.minor ?? 0) + (s.bySeverity.nit ?? 0), 0)),
  };
}
