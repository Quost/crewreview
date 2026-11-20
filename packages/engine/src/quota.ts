import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { quotaResetAt } from "@crewreview/core";
import type { Config } from "./config.ts";
import type { PickLimits } from "./harnesses.ts";
import type { ReviewEvent } from "./review.ts";

/** How long a harness waits after a usage limit whose message doesn't say when it resets. */
export const DEFAULT_PAUSE_MS = 60 * 60_000;

interface QuotaFile {
  /** Local date the run counts belong to, YYYY-MM-DD. */
  day: string;
  runs: Record<string, number>;
  paused: Record<string, { until: number; reason: string }>;
}

export interface Paused {
  harness: string;
  until: number;
  reason: string;
}

const localDay = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Which harnesses are paused after hitting their usage limit, and how many agent runs each made today (a lens, the
 * verifier and an attendant each count one). Kept in a small file, so the daemon and the CLI see the same state.
 */
export class QuotaBook {
  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static in(stateDir: string): QuotaBook {
    return new QuotaBook(join(stateDir, "quota.json"));
  }

  private read(): QuotaFile {
    const today = localDay(this.now());
    let f: QuotaFile = { day: today, runs: {}, paused: {} };
    try {
      f = { ...f, ...JSON.parse(readFileSync(this.file, "utf8")) };
    } catch {}
    if (f.day !== today) f = { ...f, day: today, runs: {} };
    return f;
  }

  private write(f: QuotaFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(f));
    renameSync(tmp, this.file);
  }

  /** When this harness can be used again, if it is paused now. */
  pausedUntil(harness: string): number | undefined {
    const p = this.read().paused[harness];
    return p && p.until > this.now() ? p.until : undefined;
  }

  pause(harness: string, until: number, reason: string): void {
    const f = this.read();
    f.paused[harness] = { until, reason: reason.slice(0, 300) };
    this.write(f);
  }

  /** A harness answered again: whatever pause it had is over. */
  resume(harness: string): void {
    const f = this.read();
    if (!f.paused[harness]) return;
    delete f.paused[harness];
    this.write(f);
  }

  countRun(harness: string): void {
    const f = this.read();
    f.runs[harness] = (f.runs[harness] ?? 0) + 1;
    this.write(f);
  }

  runsToday(): number {
    return Object.values(this.read().runs).reduce((a, b) => a + b, 0);
  }

  status(): { runsToday: number; runs: Record<string, number>; paused: Paused[] } {
    const f = this.read();
    const now = this.now();
    const paused = Object.entries(f.paused)
      .filter(([, p]) => p.until > now)
      .map(([harness, p]) => ({ harness, ...p }));
    return { runsToday: Object.values(f.runs).reduce((a, b) => a + b, 0), runs: f.runs, paused };
  }
}

const isQuota = (error: string | undefined) => Boolean(error?.startsWith("quota:") || error === "quota");

/**
 * Wrap a job's events: each agent that starts counts one run for the daily budget, and a harness whose run ended on
 * its usage limit is paused until the time its message gives (or an hour).
 */
export function watchQuota(book: QuotaBook | undefined, onEvent?: (e: ReviewEvent) => void, now: () => number = () => Date.now()): ((e: ReviewEvent) => void) | undefined {
  if (!book) return onEvent;
  let verifier: string | undefined;
  let attendant: string | undefined;
  const ended = (harness: string | undefined, ok: boolean, error: string | undefined) => {
    if (!harness) return;
    if (isQuota(error)) book.pause(harness, quotaResetAt(error!, now()) ?? now() + DEFAULT_PAUSE_MS, error!);
    else if (ok) book.resume(harness);
  };
  return (e) => {
    if (e.type === "lens-start") book.countRun(e.harness);
    else if (e.type === "verifier-start") book.countRun((verifier = e.harness));
    else if (e.type === "attendant-start") book.countRun((attendant = e.harness));
    else if (e.type === "lens-done") ended(e.result.harness, e.result.status === "ok", e.result.error);
    else if (e.type === "verifier-done") ended(verifier, e.ok, e.error);
    else if (e.type === "attendant-done") ended(attendant, e.ok, e.error);
    onEvent?.(e);
  };
}

/** The limits a pick has to respect now, from the config and the book. */
export function pickLimits(config: Config, book: QuotaBook | undefined): PickLimits {
  if (!book) return { fallback: config.harness.fallback };
  const limit = config.limits.dailyRuns;
  return { pausedUntil: (h) => book.pausedUntil(h), fallback: config.harness.fallback, budget: limit ? { used: book.runsToday(), limit } : undefined };
}
