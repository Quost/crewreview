import type { FileOracle } from "./evidence.ts";
import type { Check, CheckStatus } from "./model.ts";
import { placeExists } from "./schema.ts";

/**
 * The checks a review reports, as code decides them: a claim or rule said to hold or fail without a real place
 * (path:line in the reviewed tree) is unverified, whatever the model said. The same statement twice counts once.
 */
export function settleChecks(checks: readonly Check[], oracle?: FileOracle): Check[] {
  const seen = new Set<string>();
  const out: Check[] = [];
  for (const c of checks) {
    const key = `${c.kind}:${c.text.toLowerCase().replace(/\s+/g, " ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.status !== "unverified" && !placeExists(c.evidence, oracle)) out.push({ ...c, status: "unverified", unproven: true });
    else out.push(c);
  }
  return out;
}

export function countChecks(checks: readonly Check[]): Record<CheckStatus, number> {
  const n: Record<CheckStatus, number> = { holds: 0, fails: 0, unverified: 0 };
  for (const c of checks) n[c.status]++;
  return n;
}
