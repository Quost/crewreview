import { describe, expect, test } from "bun:test";
import { pickSeat, type SeatState } from "../src/index.ts";

const NOW = 1_000_000;
const states = (m: Record<string, Partial<SeatState>>) => (id: string): SeatState => ({ runs: 0, ...m[id] });

describe("which seat does the next run of a role", () => {
  test("order: the first seat until it's paused or out of runs, then the next", () => {
    const route = { seats: ["opus", "sonnet", "codex"], balance: "order" as const };
    expect(pickSeat(route, states({}), NOW)).toEqual({ seat: "opus" });
    expect(pickSeat(route, states({ opus: { pausedUntil: NOW + 60_000 } }), NOW)).toEqual({ seat: "sonnet" });
    expect(pickSeat(route, states({ opus: { pausedUntil: NOW - 1 } }), NOW)).toEqual({ seat: "opus" });
    expect(pickSeat(route, states({ opus: { runs: 5, dailyRuns: 5 }, sonnet: { runs: 2, busy: 1, dailyRuns: 3 } }), NOW)).toEqual({ seat: "codex" });
  });

  test("with none left: when the first comes back, or that the day's runs are spent", () => {
    const route = { seats: ["a", "b", "c"], balance: "order" as const };
    expect(pickSeat(route, states({ a: { pausedUntil: NOW + 900 }, b: { pausedUntil: NOW + 300 }, c: { runs: 1, dailyRuns: 1 } }), NOW)).toEqual({ none: "paused", until: NOW + 300 });
    expect(pickSeat(route, states({ a: { runs: 1, dailyRuns: 1 }, b: { runs: 1, dailyRuns: 1 }, c: { runs: 1, dailyRuns: 1 } }), NOW)).toEqual({ none: "budget" });
    expect(pickSeat({ seats: [], balance: "order" }, states({}), NOW)).toEqual({ none: "no-seat" });
  });

  test("spread: the seat with the most of its day left; ties go to the first", () => {
    const route = { seats: ["claude", "codex"], balance: "spread" as const };
    expect(pickSeat(route, states({}), NOW)).toEqual({ seat: "claude" });
    expect(pickSeat(route, states({ claude: { runs: 10, dailyRuns: 40 }, codex: { runs: 10, dailyRuns: 20 } }), NOW)).toEqual({ seat: "claude" });
    expect(pickSeat(route, states({ claude: { runs: 30, dailyRuns: 40 }, codex: { runs: 10, dailyRuns: 20 } }), NOW)).toEqual({ seat: "codex" });
    // Runs going on count: two lenses starting at once land on different seats.
    expect(pickSeat(route, states({ claude: { busy: 1 } }), NOW)).toEqual({ seat: "codex" });
  });

  test("cheapest: the lowest known cost per run; unknown costs come after known ones", () => {
    const route = { seats: ["opus", "kiro", "sonnet"], balance: "cheapest" as const };
    expect(pickSeat(route, states({ opus: { costPerRun: 0.9 }, sonnet: { costPerRun: 0.2 } }), NOW)).toEqual({ seat: "sonnet" });
    expect(pickSeat(route, states({ opus: { costPerRun: 0.9 }, sonnet: { costPerRun: 0.2, pausedUntil: NOW + 1 } }), NOW)).toEqual({ seat: "opus" });
    expect(pickSeat(route, states({}), NOW)).toEqual({ seat: "opus" });
  });

  test("seats already tried for this run are left out, and a seat listed twice counts once", () => {
    const route = { seats: ["a", "b", "a"], balance: "spread" as const };
    expect(pickSeat(route, states({}), NOW, ["a"])).toEqual({ seat: "b" });
    expect(pickSeat(route, states({}), NOW, ["a", "b"])).toEqual({ none: "no-seat" });
  });
});
