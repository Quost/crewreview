/**
 * Seats and roles (docs/plans/crew-mode.md). A seat is one agent the crew can hire: a harness, a model and an effort.
 * A role is a job (review, verify, build, attend…) with the seats that may do it and how to share it among them.
 */

export const BALANCES = ["order", "spread", "cheapest"] as const;
/**
 * - `order`: the first seat until it's paused or out of runs, then the next (today's fallback).
 * - `spread`: the seat with the most of its day left, so each plan is used evenly.
 * - `cheapest`: the lowest known cost per run; a seat whose cost isn't known comes after those whose is.
 */
export type Balance = (typeof BALANCES)[number];

export interface RoleRoute {
  seats: readonly string[];
  balance: Balance;
}

/** What a seat has left right now. */
export interface SeatState {
  /** Paused at its usage limit until then. */
  pausedUntil?: number;
  /** Agent runs it made today. */
  runs: number;
  /** Runs it's doing right now. */
  busy?: number;
  /** Most runs allowed today. Unset: no limit of its own. */
  dailyRuns?: number;
  /** What one run costs in dollars, when the harness reports it. */
  costPerRun?: number;
}

export type SeatPick = { seat: string } | { none: "paused"; until: number } | { none: "budget" } | { none: "no-seat" };

/** A seat without a daily limit counts as this many runs a day when `spread` compares how much of its day is used. */
export const UNLIMITED_SHARE = 100;

/**
 * Which seat does the next run of a role. Seats paused at their usage limit or out of runs today are skipped; when
 * none is left, the answer says when the first one comes back, or that the day's runs are spent. `skip` leaves out
 * seats already tried for this run (one that just failed to start, say).
 */
export function pickSeat(route: RoleRoute, state: (seat: string) => SeatState, now: number, skip: readonly string[] = []): SeatPick {
  const seats = route.seats.filter((s, i) => !skip.includes(s) && route.seats.indexOf(s) === i).map((id, order) => ({ id, order, s: state(id) }));
  if (seats.length === 0) return { none: "no-seat" };
  const paused = (x: (typeof seats)[number]) => x.s.pausedUntil !== undefined && x.s.pausedUntil > now;
  const spent = (x: (typeof seats)[number]) => x.s.dailyRuns !== undefined && x.s.runs + (x.s.busy ?? 0) >= x.s.dailyRuns;
  const free = seats.filter((x) => !paused(x) && !spent(x));
  if (free.length === 0) {
    const back = seats.filter(paused).map((x) => x.s.pausedUntil!);
    return back.length ? { none: "paused", until: Math.min(...back) } : { none: "budget" };
  }
  const by = (score: (x: (typeof free)[number]) => number) => [...free].sort((a, b) => score(a) - score(b) || a.order - b.order)[0]!;
  switch (route.balance) {
    case "order":
      return { seat: free[0]!.id };
    case "spread":
      return { seat: by((x) => (x.s.runs + (x.s.busy ?? 0)) / (x.s.dailyRuns ?? UNLIMITED_SHARE)).id };
    case "cheapest":
      return { seat: by((x) => x.s.costPerRun ?? Number.POSITIVE_INFINITY).id };
  }
}
