import type { FileOracle } from "./evidence.ts";
import type { Check, CheckStatus } from "./model.ts";
import { placeExists } from "./schema.ts";

/** The first "path:line" (or "path:line-line") in what the model wrote, which often wraps it in words. */
function placeIn(evidence: string | undefined): string | undefined {
  const m = /(?:^|[\s`(])(?:\.\/|head\/)?([\w.@-]+(?:\/[\w.@-]+)*\.[\w]+:\d+(?:-\d+)?)/.exec(evidence ?? "");
  return m?.[1];
}

/**
 * The checks a review reports, as code decides them: a claim or rule said to hold or fail without a real place
 * (path:line in the reviewed tree) is unverified, whatever the model said. The place is read out of the words around it. The same statement twice counts once.
 */
export function settleChecks(checks: readonly Check[], oracle?: FileOracle): Check[] {
  const seen = new Set<string>();
  const out: Check[] = [];
  for (const c of checks) {
    const key = `${c.kind}:${c.text.toLowerCase().replace(/\s+/g, " ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const place = placeIn(c.evidence);
    const evidence = place ?? c.evidence;
    if (c.status !== "unverified" && !placeExists(place, oracle)) out.push({ ...c, evidence, status: "unverified", unproven: true });
    else out.push({ ...c, evidence });
  }
  return out;
}

export function countChecks(checks: readonly Check[]): Record<CheckStatus, number> {
  const n: Record<CheckStatus, number> = { holds: 0, fails: 0, unverified: 0 };
  for (const c of checks) n[c.status]++;
  return n;
}
