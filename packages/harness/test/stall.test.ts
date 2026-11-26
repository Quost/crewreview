import { describe, expect, test } from "bun:test";
import { stallWatch } from "../src/stall.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("stall watch", () => {
  test("silence longer than the limit is a stall; activity resets it", () => {
    const c = clock();
    const w = stallWatch(60_000, 5_000, c.now);
    for (let i = 0; i < 11; i++) expect((c.advance(5_000), w.check())).toBe(false);
    w.activity();
    for (let i = 0; i < 12; i++) expect((c.advance(5_000), w.check())).toBe(false);
    c.advance(5_000);
    expect(w.check()).toBe(true);
  });

  test("time the computer slept doesn't count as the agent's silence", () => {
    const c = clock();
    const w = stallWatch(8 * 60_000, 5_000, c.now);
    c.advance(5_000);
    expect(w.check()).toBe(false);
    // Nine minutes asleep: the next tick comes that late.
    c.advance(9 * 60_000);
    expect(w.check()).toBe(false);
    // Awake again, the limit counts from before the sleep plus one tick.
    for (let i = 0; i < 94; i++) expect((c.advance(5_000), w.check())).toBe(false);
    c.advance(5_000);
    expect(w.check()).toBe(true);
  });

  test("a tick a little late under load is still counted", () => {
    const c = clock();
    const w = stallWatch(20_000, 5_000, c.now);
    c.advance(12_000);
    expect(w.check()).toBe(false);
    c.advance(12_000);
    expect(w.check()).toBe(true);
  });
});
