/**
 * When a harness that hit its usage limit can be used again, read from its own message. Harnesses say it in many
 * ways: "resets 3pm (America/Sao_Paulo)", "try again in 2 days 3 hours", "try again at 5:29 PM", "Retry-After: 120",
 * or an epoch after a "|". Undefined when the message doesn't say, or says something more than 8 days away.
 */
export function quotaResetAt(text: string, now: number): number | undefined {
  const at = parse(text, now);
  return at !== undefined && at > now && at - now <= 8 * 86_400_000 ? at : undefined;
}

const UNIT: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parse(text: string, now: number): number | undefined {
  const t = text.toLowerCase();

  const epoch = /\|(\d{10})\b/.exec(t);
  if (epoch) return Number(epoch[1]) * 1000;

  // "in 2 days 3 hours 12 minutes", "in 45m", "after 30 seconds"
  const span = /(?:try again|retry|resets?|available)\s+(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/.exec(t);
  if (span) {
    let ms = 0;
    for (const m of span[1]!.matchAll(/(\d+)\s*([a-z]+)/g)) ms += Number(m[1]) * (UNIT[m[2]![0]!] ?? 0);
    if (ms > 0) return now + ms;
  }

  const retryAfter = /retry-after:?\s*(\d+)/.exec(t);
  if (retryAfter) return now + Number(retryAfter[1]) * 1000;

  // "resets 3pm", "resets at 15:00", "try again at 5:29 pm", "resets mon 10am"
  const clock = /(?:try again|resets?|reset|available)\s+(?:at\s+|on\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t);
  if (clock && (clock[3] !== undefined || clock[4] !== undefined)) {
    let hour = Number(clock[2]);
    const minute = Number(clock[3] ?? 0);
    if (clock[4] === "pm" && hour < 12) hour += 12;
    if (clock[4] === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return undefined;
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (clock[1]) {
      const ahead = (DAYS.indexOf(clock[1]) - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + ahead);
      if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    } else if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }
  return undefined;
}
