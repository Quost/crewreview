/**
 * What of a failed CI job's log the agent gets. A job often keeps running after the step that broke (uploads,
 * cleanup, notifications), so the end of the log rarely holds the error: the excerpt is cut around the lines that
 * say what failed, and falls back to the end only when no such line is there.
 */

/** Lines that name a failure in common tools' output. */
const SPECIFIC = [
  /^\s*┃\s*\[[FWDRC]\]/, // credo
  /^\s*\d+\) test\b/, // ExUnit
  /^\*\* \(\w/, // an Elixir exception
  /^\s*(error|ERROR)(\[[\w-]+\])?:/, // rustc, tsc, gcc, many linters
  /\berror TS\d+:/, // tsc with a path in front
  /^(FAIL|FAILED|--- FAIL)\b/, // go, jest, pytest summaries
  /^\s*✗|^\s*✘|^\s*\(fail\)/, // bun, node test runners
  /^E\s{2,}\S/, // pytest assertion lines
  /^Traceback \(most recent call last\):/,
  /^npm ERR!/,
  /^::error\b/,
];
/** GitHub's own marker: it also ends every failed step with "Process completed with exit code N". */
const GITHUB_ERROR = /^##\[error\]/;
const STEP_EXIT = /^##\[error\]Process completed with exit code \d+/;

const SEPARATOR = "\n[…]\n";
const STEP_START = /^##\[group\]Run /;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export type FailureSignal = "specific" | "exit-only" | "none";

/** How a log line says something failed, if it does. */
function signal(line: string): FailureSignal {
  if (SPECIFIC.some((r) => r.test(line))) return "specific";
  if (GITHUB_ERROR.test(line)) return STEP_EXIT.test(line) ? "exit-only" : "specific";
  return "none";
}

/** A log without timestamps and colour codes: they cost room and say nothing about the failure. */
export function cleanLog(raw: string): string[] {
  return raw.replace(/\r\n?/g, "\n").replace(ANSI, "").split("\n").map((l) => l.replace(TIMESTAMP, ""));
}

/** The strongest failure signal anywhere in the log. */
export function failureSignal(raw: string): FailureSignal {
  let best: FailureSignal = "none";
  for (const line of cleanLog(raw)) {
    const s = signal(line);
    if (s === "specific") return s;
    if (s === "exit-only") best = s;
  }
  return best;
}

export interface ExcerptOptions {
  /** Most characters in the excerpt. */
  maxChars?: number;
  /** Lines kept before and after each failure line. */
  before?: number;
  after?: number;
  /** Lines kept when no line names the failure. */
  tail?: number;
}

/**
 * The parts of a CI log around the lines that say what failed, in log order, joined by "[…]". A step's generic exit
 * line keeps the output above it, since that's where the step printed what went wrong. Without any failure line,
 * the end of the log, as before.
 */
export function ciLogExcerpt(raw: string, o: ExcerptOptions = {}): string {
  const maxChars = o.maxChars ?? 6000;
  const before = o.before ?? 40;
  const after = o.after ?? 10;
  const lines = cleanLog(raw);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  // GitHub starts each step with "##[group]Run …": a window stays inside the step its failure line is in.
  const starts = lines.flatMap((l, i) => (STEP_START.test(l) ? [i] : []));
  const windows: [number, number][] = [];
  lines.forEach((line, i) => {
    const s = signal(line);
    if (s === "none") return;
    const stepStart = starts.filter((x) => x <= i).pop() ?? 0;
    const nextStep = starts.find((x) => x > i) ?? lines.length;
    // After a step's exit line come the next steps: nothing about this failure.
    const end = s === "exit-only" ? i + 1 : Math.min(nextStep, i + 1 + after);
    windows.push([Math.max(stepStart, i - before), end]);
  });
  if (!windows.length) return clip(lines.slice(-(o.tail ?? 120)).join("\n"), maxChars, "end");

  const merged: [number, number][] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  const parts: string[] = [];
  let used = 0;
  for (const [from, to] of merged) {
    const sep = parts.length ? SEPARATOR.length : 0;
    const room = maxChars - used - sep - 8;
    if (room < 200) break;
    // The first failures matter most; a block too long for what's left keeps its start.
    const text = clip(lines.slice(from, to).join("\n"), room, "start");
    parts.push(text);
    used += sep + text.length;
  }
  const head = merged[0]![0] > 0 ? "[…]\n" : "";
  const tail = merged[merged.length - 1]![1] < lines.length || parts.length < merged.length ? "\n[…]" : "";
  return head + parts.join(SEPARATOR) + tail;
}

function clip(text: string, max: number, keep: "start" | "end"): string {
  if (text.length <= max) return text;
  return keep === "end" ? text.slice(-max) : text.slice(0, max);
}

/** Names of jobs that only gather the others' results: their failure says nothing of its own. */
const AGGREGATOR = /\b(summary|all[ -]?(checks|jobs|green)|ci[ -]status|required[ -]checks?|gate|results?)\b/i;

/**
 * Which failing jobs to show the agent, at most `limit`: those whose log names a failure first, then those that only
 * exited non-zero, then the rest; a job named like a summary of the others goes after the jobs it sums up. Ties
 * keep the host's order.
 */
export function pickFailingJobs<T extends { name: string; log?: string }>(jobs: readonly T[], limit = 3): T[] {
  const rank = (j: T) => {
    const s = j.log ? failureSignal(j.log) : "none";
    return (s === "specific" ? 0 : s === "exit-only" ? 1 : 2) + (AGGREGATOR.test(j.name) ? 3 : 0);
  };
  return jobs
    .map((j, i) => ({ j, i, r: rank(j) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.j);
}
