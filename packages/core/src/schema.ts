import { z } from "zod";
import { normalizeRepoPath, type FileOracle } from "./evidence.ts";
import { CONFIDENCES, lessSevere, SEVERITIES, type Confidence, type Finding, type Severity } from "./model.ts";

const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: "blocker", critical: "blocker", crit: "blocker", severe: "blocker", "must-fix": "blocker",
  major: "major", high: "major", important: "major", error: "major",
  minor: "minor", medium: "minor", moderate: "minor", warning: "minor", warn: "minor",
  nit: "nit", low: "nit", info: "nit", trivial: "nit", style: "nit", suggestion: "nit", nitpick: "nit",
};

export function coerceSeverity(v: unknown): Severity | undefined {
  if (typeof v !== "string") return undefined;
  return SEVERITY_ALIASES[v.trim().toLowerCase()];
}

function coerceConfidence(v: unknown): Confidence {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (CONFIDENCES as readonly string[]).includes(s) ? (s as Confidence) : "medium";
}

const RawFinding = z.object({
  path: z.string().min(1),
  line: z.coerce.number().int(),
  endLine: z.coerce.number().int().optional().catch(undefined),
  severity: z.unknown().transform(coerceSeverity).pipe(z.enum(SEVERITIES)),
  title: z.string().min(1).transform((s) => s.trim().slice(0, 200)),
  body: z.string().default(""),
  evidence: z.string().optional().catch(undefined),
  suggestion: z.string().optional().catch(undefined),
  confidence: z.unknown().optional().transform(coerceConfidence),
});

export interface LensOutput {
  findings: Omit<Finding, "id" | "lens" | "lenses">[];
  coverage: "full" | "partial";
  uncovered: string[];
  /** Raw findings that didn't fit the schema. */
  rejected: number;
}

/** Validate a lens answer finding by finding: one malformed entry doesn't throw away the others. */
export function parseLensOutput(value: unknown): LensOutput | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const list = Array.isArray(obj.findings) ? obj.findings : Array.isArray(value) ? (value as unknown[]) : undefined;
  if (list === undefined) return undefined;
  const findings: LensOutput["findings"] = [];
  let rejected = 0;
  for (const item of list) {
    const r = RawFinding.safeParse(item);
    if (r.success) findings.push(r.data);
    else rejected++;
  }
  const coverage = obj.coverage === "partial" ? "partial" : "full";
  const uncovered = Array.isArray(obj.uncovered) ? obj.uncovered.filter((x): x is string => typeof x === "string") : [];
  return { findings, coverage, uncovered, rejected };
}

const Decision = z.object({
  id: z.string().min(1),
  action: z.enum(["confirm", "downgrade", "upgrade", "drop", "duplicate"]),
  severity: z.unknown().transform(coerceSeverity).optional(),
  /** For "duplicate": the id of the finding this one repeats. */
  of: z.string().optional().catch(undefined),
  /** For "upgrade": where (path:line) the code shows the impact. */
  evidence: z.string().optional().catch(undefined),
  reason: z.string().default(""),
});
export type VerifierDecision = z.infer<typeof Decision>;

export function parseVerifierOutput(value: unknown): VerifierDecision[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const list = (value as Record<string, unknown>).decisions;
  if (!Array.isArray(list)) return undefined;
  const out: VerifierDecision[] = [];
  for (const item of list) {
    const r = Decision.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

export interface VerifierRules {
  /** Accept upgrades at all. */
  raise: boolean;
  /** The highest severity an upgrade can reach: a blocker has to come from a lens. */
  raiseTo: Severity;
  /** Checks an upgrade's evidence points at a real line of the reviewed tree. */
  oracle?: FileOracle;
}

const RAISE: VerifierRules = { raise: false, raiseTo: "major" };

/** "lib/a.ex:120" (or "lib/a.ex:120-130") pointing at a real line, when an oracle can tell. */
function placeExists(evidence: string | undefined, oracle: FileOracle | undefined): boolean {
  const m = /^\s*`?([^\s`:]+):(\d+)(?:-\d+)?`?\s*$/.exec(evidence ?? "");
  if (!m) return false;
  if (!oracle) return true;
  const path = normalizeRepoPath(m[1]!);
  const lines = path ? oracle.lineCount(path) : null;
  return lines !== null && Number(m[2]) >= 1 && Number(m[2]) <= lines;
}

/**
 * Apply the verifier's decisions. It may confirm, downgrade, drop, or mark a finding as a duplicate of another (its
 * lenses move to the one that stays). When the rules allow, it may also raise a severity, but only with a reason and
 * a real place (path:line) that shows the impact, and never past `raiseTo`; an upgrade without them stays a confirm.
 * With the same rules, a downgrade needs a real place too (what makes the impact smaller), or it stays a confirm: in
 * calibration the verifier lowered the very risks the lenses had found right, with nothing to show for it.
 * A finding the verifier skipped stays as it was, without a verification mark.
 */
export function applyVerifier(findings: readonly Finding[], decisions: readonly VerifierDecision[], rules: VerifierRules = RAISE): {
  kept: Finding[];
  dropped: Finding[];
} {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const ids = new Set(findings.map((f) => f.id));
  // A duplicate must point at another finding that itself stays (not dropped, not a duplicate).
  const survivor = (id: string | undefined): boolean => {
    const d = id === undefined ? undefined : byId.get(id);
    return id !== undefined && ids.has(id) && d?.action !== "drop" && d?.action !== "duplicate";
  };
  const extraLenses = new Map<string, string[]>();
  for (const f of findings) {
    const d = byId.get(f.id);
    if (d?.action === "duplicate" && d.of !== f.id && survivor(d.of)) {
      extraLenses.set(d.of!, [...(extraLenses.get(d.of!) ?? []), ...f.lenses]);
    }
  }
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const raw of findings) {
    const more = extraLenses.get(raw.id);
    const f = more ? { ...raw, lenses: [...new Set([...raw.lenses, ...more])] } : raw;
    const d = byId.get(f.id);
    if (!d) {
      kept.push(f);
      continue;
    }
    if (d.action === "duplicate") {
      if (d.of !== f.id && survivor(d.of)) {
        dropped.push({ ...f, verification: { action: "duplicate", reason: d.reason, of: d.of } });
      } else {
        kept.push({ ...f, verification: { action: "confirm", reason: d.reason } });
      }
      continue;
    }
    if (d.action === "drop") {
      dropped.push({ ...f, verification: { action: "drop", reason: d.reason } });
      continue;
    }
    // Lowering needs proof as much as raising: a guard, a caller that handles it, a path that never runs.
    if (d.action === "downgrade" && d.severity && lessSevere(d.severity, f.severity) && (!rules.raise || placeExists(d.evidence, rules.oracle))) {
      kept.push({ ...f, severity: d.severity, verification: { action: "downgrade", reason: d.reason, from: f.severity } });
      continue;
    }
    if (d.action === "upgrade" && rules.raise && d.severity && d.reason.trim() && placeExists(d.evidence, rules.oracle)) {
      const to = lessSevere(rules.raiseTo, d.severity) ? rules.raiseTo : d.severity;
      if (lessSevere(f.severity, to)) {
        kept.push({ ...f, severity: to, verification: { action: "upgrade", reason: d.reason, from: f.severity, evidence: d.evidence!.trim() } });
        continue;
      }
    }
    kept.push({ ...f, verification: { action: "confirm", reason: d.reason } });
  }
  return { kept, dropped };
}
