import type { FailureKind } from "./types.ts";
import type { ProcessResult } from "./process.ts";

const QUOTA = /(usage limit|rate.?limit|quota|too many requests|\b429\b|credit balance|out of credits|limit reached|insufficient_quota|overloaded)/i;
const AUTH = /(not logged in|log ?in required|please (run )?\/?login|authentication (is )?required|unauthori[sz]ed|invalid api key|oauth token (has )?expired|\b401\b|sign in)/i;

/** Classify why a run failed from its exit and output. Patterns are broad on purpose. */
export function classifyFailure(r: ProcessResult, text = ""): FailureKind | undefined {
  if (r.spawnError) return "crash";
  if (r.aborted) return "aborted";
  if (r.timedOut) return "timeout";
  if (r.stalled) return "stalled";
  const all = `${text}\n${r.stderr}\n${r.stdout.slice(-4000)}`;
  if (r.exitCode !== 0 || text === "") {
    if (QUOTA.test(all)) return "quota";
    if (AUTH.test(all)) return "auth";
    if (r.exitCode !== 0) return "crash";
  }
  return undefined;
}

export function lastLines(text: string, n = 12): string {
  return text.trim().split("\n").slice(-n).join("\n");
}
