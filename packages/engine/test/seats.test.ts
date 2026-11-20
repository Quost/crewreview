import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "@crewreview/harness";
import { parseConfig, QuotaBook, SeatBook, type ConformanceStore, type SeatChoice } from "../src/index.ts";

const NOW = new Date(2026, 10, 20, 14, 0, 0).getTime();

function harness(id: string, write = true): Harness {
  return {
    id,
    name: id,
    kind: "native",
    capabilities: { readOnly: "enforced", write, streaming: false, costReport: false, modelSelect: true },
    detect: async () => ({ installed: true, version: "1" }),
    run: async () => ({ ok: true, text: "", exitCode: 0, durationMs: 1 }),
  };
}

const proven = { get: async () => ({ readOnly: "pass", writeScope: "pass", structured: "pass", at: "" }) } as unknown as ConformanceStore;
const registry = new Map([harness("claude"), harness("codex"), harness("kiro", false)].map((h) => [h.id, h]));

async function seatBook(config: object) {
  const book = new QuotaBook(join(await mkdtemp(join(tmpdir(), "crewreview-seats-")), "quota.json"), () => NOW);
  return { book, seats: new SeatBook(parseConfig(config), registry, proven, book, () => NOW) };
}

const SEATS = {
  "opus-high": { harness: "claude", model: "claude-opus-5-5", effort: "high" },
  "opus-med": { harness: "claude", model: "claude-opus-5-5", effort: "medium" },
  sonnet: { harness: "claude", model: "claude-sonnet-5-5" },
  fast: { harness: "codex", model: "gpt-6.1-sol", effort: "low", dailyRuns: 2 },
};

describe("seats for a role", () => {
  test("a seat comes with its harness, model and effort, and counts a run for itself and for the day", async () => {
    const { book, seats } = await seatBook({ seats: SEATS, roles: { review: ["fast", "sonnet"] } });
    const c = (await seats.picker("review")!([])) as SeatChoice;
    expect([c.seat, c.harness.id, c.model, c.effort]).toEqual(["fast", "codex", "gpt-6.1-sol", "low"]);
    c.done();
    expect([book.seatRunsToday("fast"), book.runsToday()]).toEqual([1, 1]);
  });

  test("spread hands concurrent runs to different seats; a seat out of runs is skipped", async () => {
    const { seats } = await seatBook({ seats: SEATS, roles: { review: { seats: ["fast", "sonnet"], balance: "spread" } } });
    const pick = seats.picker("review")!;
    const a = (await pick([])) as SeatChoice;
    const b = (await pick([])) as SeatChoice;
    expect([a.seat, b.seat]).toEqual(["fast", "sonnet"]);
    a.done();
    b.done();
    // fast has used 1 of its 2 runs; sonnet has no limit of its own (it counts as 100), so it has more day left.
    const c = (await pick([])) as SeatChoice;
    c.done();
    expect(c.seat).toBe("sonnet");
  });

  test("spread: lenses asking at the same moment land on different seats", async () => {
    const { seats } = await seatBook({ seats: SEATS, roles: { review: { seats: ["sonnet", "codex"], balance: "spread" } } });
    const pick = seats.picker("review")!;
    const got = (await Promise.all([pick([]), pick([]), pick([]), pick([])])) as SeatChoice[];
    expect(got.map((c) => c.seat).sort()).toEqual(["codex", "codex", "sonnet", "sonnet"]);
  });

  test("order keeps to the first seat until it's out of runs", async () => {
    const { seats } = await seatBook({ seats: SEATS, roles: { review: ["fast", "sonnet"] } });
    const pick = seats.picker("review")!;
    const got: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = (await pick([])) as SeatChoice;
      got.push(c.seat);
      c.done();
    }
    expect(got).toEqual(["fast", "fast", "sonnet"]);
  });

  test("a usage limit pauses the seat and those on the same harness and model, not another model", async () => {
    const { book, seats } = await seatBook({ seats: SEATS, roles: { review: ["opus-high", "opus-med", "sonnet"] } });
    const c = (await seats.picker("review")!([])) as SeatChoice;
    c.limit("5-hour limit reached ∙ resets 3pm");
    c.done();
    const until = new Date(2026, 10, 20, 15, 0, 0).getTime();
    expect([book.seatPausedUntil("opus-high"), book.seatPausedUntil("opus-med"), book.seatPausedUntil("sonnet")]).toEqual([until, until, undefined]);
    expect(((await seats.picker("review")!([])) as SeatChoice).seat).toBe("sonnet");
  });

  test("none left says when the first comes back; a harness that can't do the job is passed over", async () => {
    const { book, seats } = await seatBook({ seats: { ...SEATS, ro: { harness: "kiro" } }, roles: { review: ["opus-high"], attend: ["ro", "sonnet"] } });
    book.pauseSeat("opus-high", NOW + 60_000, "quota");
    expect(await seats.picker("review")!([])).toEqual({ error: "paused", name: "opus-high", until: NOW + 60_000 });
    // The attendant writes: kiro can't, so it's skipped for the next seat.
    expect(((await seats.picker("attend")!([])) as SeatChoice).seat).toBe("sonnet");
    expect(await seats.available("attend")).toBe(registry.get("claude")!);
  });

  test("without [roles] a job has no picker and works as before; verify follows review", async () => {
    const { seats } = await seatBook({});
    expect([seats.picker("review"), await seats.available("verify")]).toEqual([undefined, undefined]);
    const routed = await seatBook({ seats: SEATS, roles: { review: ["sonnet"] } });
    expect(((await routed.seats.picker("verify")!([])) as SeatChoice).seat).toBe("sonnet");
    // A harness id stands for a seat of its own.
    const plain = await seatBook({ roles: { review: ["codex"] } });
    expect(((await plain.seats.picker("review")!([])) as SeatChoice).harness.id).toBe("codex");
  });
});
