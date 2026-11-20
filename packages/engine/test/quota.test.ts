import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PAUSE_MS, QuotaBook, watchQuota, type ReviewEvent } from "../src/index.ts";

const day = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime();

async function book(clock: { now: number }) {
  return new QuotaBook(join(await mkdtemp(join(tmpdir(), "crewreview-quota-")), "quota.json"), () => clock.now);
}

describe("usage limits", () => {
  test("a pause lasts until its time; runs count per day and start over at midnight", async () => {
    const clock = { now: day(19, 14) };
    const b = await book(clock);
    b.pause("claude", day(19, 15), "quota: limit reached");
    b.countRun("claude");
    b.countRun("codex");
    expect([b.pausedUntil("claude"), b.pausedUntil("codex"), b.runsToday()]).toEqual([day(19, 15), undefined, 2]);
    clock.now = day(19, 16);
    expect(b.pausedUntil("claude")).toBeUndefined();
    expect(b.status().paused).toEqual([]);
    clock.now = day(20, 0) + 1;
    expect(b.runsToday()).toBe(0);
  });

  test("the watcher counts each agent and pauses a harness at its limit, until the time it gives", async () => {
    const clock = { now: day(19, 14) };
    const b = await book(clock);
    const seen: string[] = [];
    const on = watchQuota(b, (e) => seen.push(e.type), () => clock.now)!;
    const lens = (harness: string, error?: string) => ({ type: "lens-done", result: { lens: "security", harness, status: error ? "failed" : "ok", findings: [], coverage: "full", uncovered: [], durationMs: 1, error } }) as ReviewEvent;
    on({ type: "lens-start", lens: "security", harness: "claude" });
    on({ type: "lens-start", lens: "tests", harness: "claude" });
    on({ type: "verifier-start", harness: "codex" });
    on(lens("claude", "quota: 5-hour limit reached ∙ resets 3pm"));
    on({ type: "verifier-done", ok: false, dropped: 0, downgraded: 0, error: "quota: You've hit your usage limit." });
    expect(b.runsToday()).toBe(3);
    expect(b.pausedUntil("claude")).toBe(day(19, 15));
    expect(b.pausedUntil("codex")).toBe(day(19, 14) + DEFAULT_PAUSE_MS);
    expect(seen).toHaveLength(5);
    // A crash isn't a limit; a harness that answers again is no longer paused.
    on({ type: "attendant-start", harness: "codex" });
    on({ type: "attendant-done", ok: true });
    expect(b.pausedUntil("codex")).toBeUndefined();
    on(lens("kiro", "crash: exit 1"));
    expect(b.pausedUntil("kiro")).toBeUndefined();
  });
});
