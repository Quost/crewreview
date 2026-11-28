import { describe, expect, test } from "bun:test";
import { acpHarness, buildRegistry, noteUsageUpdate, usageOf, type AcpReportedUsage } from "../src/index.ts";

describe("usage an ACP agent reports", () => {
  test("Antigravity: the turn's tokens, as its prompt response carries them", () => {
    // `agy acp` 1.5.19, one small turn, 2026-11-28: cached and thought counters come along; they are not added again.
    expect(
      usageOf({
        stopReason: "end_turn",
        usage: { inputTokens: 15755, outputTokens: 24, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 19, totalTokens: 15779 },
      }),
    ).toEqual({ inputTokens: 15755, outputTokens: 24 });
  });

  test("OpenCode: tokens from usage, and the session cost its usage_update reported before the answer", () => {
    const reported: AcpReportedUsage = {};
    noteUsageUpdate({ sessionUpdate: "usage_update", used: 1540, size: 200_000, cost: { amount: 0.012, currency: "USD" } }, reported);
    expect(usageOf({ stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 } }, reported)).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.012,
    });
  });

  test("Gemini CLI: snake_case tokens under its own _meta.quota", () => {
    expect(usageOf({ stopReason: "end_turn", _meta: { quota: { token_count: { input_tokens: 1234, output_tokens: 567 } } } })).toEqual({
      inputTokens: 1234,
      outputTokens: 567,
    });
  });

  test("an agent that only sends context updates still counts the run", () => {
    const reported: AcpReportedUsage = {};
    noteUsageUpdate({ sessionUpdate: "usage_update", used: 53_000, size: 200_000 }, reported);
    expect(usageOf({ stopReason: "end_turn" }, reported)).toEqual({ inputTokens: 53_000 });
  });

  test("a total without a breakdown gives the input back, and a cost in credits is not dollars", () => {
    const reported: AcpReportedUsage = {};
    noteUsageUpdate({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 3, currency: "credits" } }, reported);
    expect(usageOf({ stopReason: "end_turn", usage: { totalTokens: 1000, outputTokens: 400 } }, reported)).toEqual({ inputTokens: 600, outputTokens: 400 });
  });

  test("a cost of null clears the one reported before it", () => {
    const reported: AcpReportedUsage = {};
    noteUsageUpdate({ sessionUpdate: "usage_update", used: 5, size: 100, cost: { amount: 0.5, currency: "USD" } }, reported);
    noteUsageUpdate({ sessionUpdate: "usage_update", used: 6, size: 100, cost: null }, reported);
    expect(usageOf({ stopReason: "end_turn" }, reported)).toEqual({ inputTokens: 6 });
  });

  test("an agent that says nothing is not given numbers", () => {
    expect(usageOf({ stopReason: "end_turn" })).toBeUndefined();
    expect(usageOf({ stopReason: "end_turn", usage: {} })).toBeUndefined();
    expect(usageOf(undefined)).toBeUndefined();
  });
});

describe("what the ACP agents tell doctor about usage", () => {
  test("the presets that report it say yes; Freebuff, which sends none yet, says no", () => {
    const reg = buildRegistry();
    for (const id of ["agy", "opencode", "gemini"]) expect(reg.get(id)!.capabilities.costReport).toBe(true);
    expect(reg.get("freebuff")!.capabilities.costReport).toBe(false);
    // An ACP agent of your own is read for whatever it sends.
    expect(acpHarness({ id: "mine", command: ["mine", "acp"] }).capabilities.costReport).toBe(true);
    expect(acpHarness({ id: "quiet", command: ["quiet", "acp"], costReport: false }).capabilities.costReport).toBe(false);
  });
});
