import { describe, expect, test } from "bun:test";
import { quotaResetAt } from "../src/index.ts";

// Thursday 19 November 2026, 14:00 local time.
const now = new Date(2026, 10, 19, 14, 0, 0).getTime();
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime();

describe("when a harness can be used again", () => {
  test("a time of day: later today, or tomorrow when it has passed", () => {
    expect(quotaResetAt("5-hour limit reached ∙ resets 3pm (America/Sao_Paulo)", now)).toBe(local(19, 15));
    expect(quotaResetAt("You've hit your usage limit. Try again at 5:29 PM.", now)).toBe(local(19, 17, 29));
    expect(quotaResetAt("limit reached, resets at 09:30", now)).toBe(local(20, 9, 30));
    expect(quotaResetAt("resets 12am", now)).toBe(local(20, 0));
  });

  test("a weekday", () => {
    expect(quotaResetAt("Weekly limit reached ∙ resets Mon 10am", now)).toBe(local(23, 10));
    expect(quotaResetAt("resets thursday at 1pm", now)).toBe(local(26, 13));
  });

  test("a span, Retry-After or an epoch", () => {
    expect(quotaResetAt("You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours 12 minutes.", now)).toBe(now + (2 * 24 * 60 + 3 * 60 + 12) * 60_000);
    expect(quotaResetAt("rate limited, retry after 45s", now)).toBe(now + 45_000);
    expect(quotaResetAt("HTTP 429 Too Many Requests\nRetry-After: 120", now)).toBe(now + 120_000);
    expect(quotaResetAt("Claude AI usage limit reached|1795140000", now)).toBe(1795140000 * 1000);
  });

  test("nothing usable: the caller picks a pause", () => {
    expect(quotaResetAt("You have reached your monthly limit.", now)).toBeUndefined();
    expect(quotaResetAt("resets in 30 days", now)).toBeUndefined();
    expect(quotaResetAt("try again at 25:00", now)).toBeUndefined();
    expect(quotaResetAt("version 3 reset", now)).toBeUndefined();
  });
});
