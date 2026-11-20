import { pickSeat, quotaResetAt, type RoleRoute, type SeatState } from "@crewreview/core";
import type { Harness } from "@crewreview/harness";
import type { Config } from "./config.ts";
import type { ConformanceStore } from "./conformance-store.ts";
import { isPickError, reviewerOnce, writerOnce, type PickError } from "./harnesses.ts";
import { DEFAULT_PAUSE_MS, type QuotaBook } from "./quota.ts";

/** The jobs that route through seats today. Build and plan come with crew mode (docs/plans/crew-mode.md). */
export type Role = "review" | "verify" | "attend";

/** A seat, resolved: a harness id, and what to ask it for. */
export interface SeatSpec {
  id: string;
  harness: string;
  model?: string;
  effort?: string;
  dailyRuns?: number;
}

/** A seat handed out for one agent run: call `done` when the run ends, and `limit` when it ended on a usage limit. */
export interface SeatChoice {
  seat: string;
  harness: Harness;
  model?: string;
  effort?: string;
  done(): void;
  limit(message: string): void;
}

/** Picks the seat for one run of a role, leaving out seats already tried for it. */
export type SeatPicker = (skip: readonly string[]) => Promise<SeatChoice | PickError>;

/**
 * A seat by its name in [seats], or a harness id standing for that harness with its own settings
 * ([harness.claude] model and effort).
 */
export function seatSpec(config: Config, id: string): SeatSpec {
  const s = config.seats[id];
  if (s) return { id, harness: s.harness, model: s.model, effort: s.effort, dailyRuns: s.dailyRuns };
  const own = (config.harness as Record<string, { model?: string; effort?: string } | undefined>)[id];
  return { id, harness: id, model: own?.model, effort: own?.effort };
}

/** The route a role takes, when [roles] names one. Verify falls back to review's seats. */
export function roleRoute(config: Config, role: Role): RoleRoute | undefined {
  return config.roles[role] ?? (role === "verify" ? config.roles.review : undefined);
}

/**
 * Hands out seats. Paused seats and seats out of runs are skipped; a seat whose harness can't do the job (not
 * installed, not proven read-only for review, not proven to write only in its worktree for the attendant, signed
 * out) is skipped too. A seat that hits its usage limit is paused, and so is every seat on the same harness and model,
 * which share that limit; seats on the same harness with another model stay, since limits can be per model.
 */
export class SeatBook {
  private readonly busy = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly registry: Map<string, Harness>,
    private readonly conformance: ConformanceStore,
    private readonly book: QuotaBook | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  state(id: string): SeatState {
    const spec = seatSpec(this.config, id);
    return { runs: this.book?.seatRunsToday(id) ?? 0, busy: this.busy.get(id) ?? 0, pausedUntil: this.book?.seatPausedUntil(id), dailyRuns: spec.dailyRuns };
  }

  /** A picker for a role, or undefined when [roles] doesn't name it (the job then works as before). */
  picker(role: Role, opts: { write?: boolean } = {}): SeatPicker | undefined {
    const route = roleRoute(this.config, role);
    if (!route) return undefined;
    return (skip) => this.pick(role, route, skip, true, opts.write ?? role === "attend") as Promise<SeatChoice | PickError>;
  }

  /**
   * Whether a job of this role could start now, and on which harness, without taking a seat: a job checks this
   * before it fetches anything. Undefined when [roles] doesn't name the role.
   */
  async available(role: Role, opts: { write?: boolean } = {}): Promise<Harness | PickError | undefined> {
    const route = roleRoute(this.config, role);
    if (!route) return undefined;
    const p = await this.pick(role, route, [], false, opts.write ?? role === "attend");
    return isPickError(p) ? p : (p as { harness: Harness }).harness;
  }

  private async pick(role: Role, route: RoleRoute, skip: readonly string[], take: boolean, write: boolean): Promise<SeatChoice | { harness: Harness } | PickError> {
    const limit = this.config.limits.dailyRuns;
    if (limit && this.book && this.book.runsToday() >= limit) return { error: "budget", limit };
    const tried = [...skip];
    let first: PickError | undefined;
    for (;;) {
      const p = pickSeat(route, (id) => this.state(id), this.now(), tried);
      if ("none" in p) {
        if (first) return first;
        if (p.none === "paused") return { error: "paused", name: route.seats.filter((s) => !skip.includes(s))[0] ?? route.seats[0]!, until: p.until };
        if (p.none === "budget") return { error: "budget", limit: route.seats.reduce((n, s) => n + (seatSpec(this.config, s).dailyRuns ?? 0), 0) };
        return { error: "no-harness" };
      }
      const spec = seatSpec(this.config, p.seat);
      // Held before the check below awaits: lenses asking at the same moment must see this seat as taken.
      if (take) this.hold(spec.id, 1);
      const h = await this.usable(spec, write);
      if (isPickError(h)) {
        if (take) this.hold(spec.id, -1);
        first ??= h;
        tried.push(p.seat);
        continue;
      }
      return take ? this.handOut(spec, h) : { harness: h };
    }
  }

  /** Writing (the attendant fixing code) needs the write-scope proof; everything else the read-only lock. */
  private async usable(spec: SeatSpec, write: boolean): Promise<Harness | PickError> {
    if (!this.registry.has(spec.harness)) return { error: "unknown-harness", name: spec.harness };
    return write ? writerOnce(this.registry, spec.harness, this.conformance) : reviewerOnce(this.registry, spec.harness, this.conformance);
  }

  private hold(id: string, by: 1 | -1): void {
    this.busy.set(id, Math.max(0, (this.busy.get(id) ?? 0) + by));
  }

  /** The seat is already held; this counts its run and gives back the handle that frees it. */
  private handOut(spec: SeatSpec, harness: Harness): SeatChoice {
    this.book?.countSeatRun(spec.id, spec.harness);
    let ended = false;
    return {
      seat: spec.id,
      harness,
      model: spec.model,
      effort: spec.effort,
      done: () => {
        if (ended) return;
        ended = true;
        this.hold(spec.id, -1);
      },
      limit: (message) => {
        const until = quotaResetAt(message, this.now()) ?? this.now() + DEFAULT_PAUSE_MS;
        for (const id of this.sharing(spec)) this.book?.pauseSeat(id, until, message);
      },
    };
  }

  /** This seat and the others on the same harness and model: they draw on the same usage limit. */
  private sharing(spec: SeatSpec): string[] {
    const named = Object.keys(this.config.seats);
    const routed = Object.values(this.config.roles).flatMap((r) => r?.seats ?? []);
    const all = [...new Set([...named, ...routed, spec.id])];
    return all.filter((id) => {
      const o = seatSpec(this.config, id);
      return id === spec.id || (o.harness === spec.harness && (o.model ?? "") === (spec.model ?? ""));
    });
  }
}

/** The harness as a seat of its own, with its [harness.<id>] model and effort: how a job runs without [roles]. */
export function fixedSeatChoice(h: Harness, config: Config): SeatChoice {
  const own = seatSpec(config, h.id);
  return { seat: h.id, harness: h, model: own.model, effort: own.effort, done: () => {}, limit: () => {} };
}

/** A picker that always hands out that seat: a pause on it is the harness's, which the quota book already keeps. */
export function fixedSeat(h: Harness, config: Config): SeatPicker {
  return async (skip) => (skip.includes(h.id) ? { error: "no-harness" } : fixedSeatChoice(h, config));
}
