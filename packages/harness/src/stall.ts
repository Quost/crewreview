/**
 * Says when a run has gone quiet for too long. The computer's sleep doesn't count: a check that comes much later
 * than it was due means the process was suspended, and that gap is taken off the silence instead of blamed on
 * the agent. Without this, a laptop that sleeps for nine minutes kills every agent it was running.
 */
export interface StallWatch {
  /** The agent did something: printed, asked or answered. */
  activity(): void;
  /** Call on every tick. True when the run is stalled. */
  check(): boolean;
}

export function stallWatch(stallMs: number, tickMs: number, now: () => number = Date.now): StallWatch {
  let last = now();
  let lastTick = last;
  // A tick may come late under load; only a gap far past it is a suspension.
  const late = Math.max(tickMs * 3, 15_000);
  return {
    activity() {
      last = now();
    },
    check() {
      const t = now();
      const gap = t - lastTick;
      lastTick = t;
      if (gap > late) last += gap - tickMs;
      return t - last > stallMs;
    },
  };
}
