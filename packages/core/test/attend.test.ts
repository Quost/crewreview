import { describe, expect, test } from "bun:test";
import { makeMarker, parseAttendOutput, pendingItems, sensitivePaths, settled, type AttendRules, type AttendThread } from "../src/index.ts";

const rules: AttendRules = { me: "quost", trustedBots: ["copilot"], fromCrew: false };
const c = (id: string, author: string, body: string, createdAt = "2026-11-19T10:00:00Z", authorIsBot = false) => ({ id, author, authorIsBot, body, createdAt });
const th = (id: string, comments: AttendThread["comments"], p: Partial<AttendThread> = {}): AttendThread => ({
  id,
  path: "src/a.ts",
  line: 3,
  resolvable: true,
  resolved: false,
  outdated: false,
  comments,
  ...p,
});
const finding = makeMarker({ kind: "finding", ref: "F1@abc", version: "0.1.0" });
const reply = makeMarker({ kind: "reply", ref: "thread:x", version: "0.1.0" });

describe("attendant items", () => {
  test("open threads from others, last word not ours", () => {
    const items = pendingItems({
      threads: [
        th("T1", [c("1", "bia", "Escape the query?")]),
        th("T2", [c("2", "bia", "Rename this"), c("3", "quost", "Done, thanks")]), // you answered last
        th("T3", [c("4", "bia", "Why?"), c("5", "quost", `Because…\n${reply}`)]), // we answered last
        th("T4", [c("6", "bia", "Fixed?")], { resolved: true }),
        th("T5", [c("7", "dependabot[bot]", "bump", undefined, true)]),
        th("T6", [c("8", "copilot-pull-request-reviewer", "Possible null", undefined, true)]),
        th("T7", [c("9", "quost", `🔴 SQL injection\n${finding}`)]), // our own reviewer: off by default
        th("T8", [c("10", "bia", "And here?"), c("11", "quost", "Good point"), c("12", "bia", "So?")]),
      ],
      reviews: [],
      rules,
      done: new Set(),
    });
    expect(items.map((i) => i.key)).toEqual(["thread:T1:1", "thread:T6:8", "thread:T8:12"]);
    expect(items[2]!.text).toContain("bia: So?");
  });

  test("the polish loop takes our own reviewer's findings", () => {
    const items = pendingItems({ threads: [th("T7", [c("9", "quost", `🔴 SQL injection\n${finding}`)])], reviews: [], rules: { ...rules, fromCrew: true }, done: new Set() });
    expect(items).toHaveLength(1);
    expect(items[0]!.fromCrew).toBe(true);
  });

  test("a new comment is a new item; handled keys are skipped", () => {
    const threads = [th("T1", [c("1", "bia", "Escape?")])];
    expect(pendingItems({ threads, reviews: [], rules, done: new Set(["thread:T1:1"]) })).toEqual([]);
    const more = [th("T1", [c("1", "bia", "Escape?"), c("2", "bia", "Ping")])];
    expect(pendingItems({ threads: more, reviews: [], rules, done: new Set(["thread:T1:1"]) }).map((i) => i.key)).toEqual(["thread:T1:2"]);
  });

  test("reviews and conversation comments with text", () => {
    const items = pendingItems({
      threads: [th("C1", [c("20", "bia", "Please add a test")], { path: undefined, line: undefined, resolvable: false }), th("C2", [c("21", "bia", `summary\n${makeMarker({ kind: "review", ref: "x", version: "1" })}`)], { resolvable: false })],
      reviews: [
        { id: "R1", author: "bia", state: "changes_requested", body: "See comments, and the changelog is missing." },
        { id: "R2", author: "bia", state: "approved", body: "LGTM" },
        { id: "R3", author: "bia", state: "commented", body: "" },
      ],
      rules,
      done: new Set(),
    });
    expect(items.map((i) => i.key)).toEqual(["comment:C1:20", "review:R1"]);
  });

  test("debounce", () => {
    const items = pendingItems({ threads: [th("T1", [c("1", "bia", "x", "2026-11-19T10:00:00Z")])], reviews: [], rules, done: new Set() });
    expect(settled(items, Date.parse("2026-11-19T10:00:30Z"), 45_000)).toBe(false);
    expect(settled(items, Date.parse("2026-11-19T10:01:00Z"), 45_000)).toBe(true);
  });

  test("sensitive paths and the agent's answer", () => {
    expect(sensitivePaths(["src/a.ts", ".github/workflows/ci.yml", "api/.env.local", "AGENTS.md", "infra/main.tf"])).toEqual([".github/workflows/ci.yml", "api/.env.local", "AGENTS.md", "infra/main.tf"]);
    const items = pendingItems({ threads: [th("T1", [c("1", "bia", "a")]), th("T2", [c("2", "bia", "b")])], reviews: [], rules, done: new Set() });
    const out = parseAttendOutput({ items: [{ key: "thread:T1:1", action: "fixed", reply: "Done." }, { key: "bogus", action: "fixed" }, { key: "thread:T2:2", action: "maybe" }], summary: "s" }, items)!;
    expect(out.decisions).toEqual([
      { key: "thread:T1:1", action: "fixed", reply: "Done." },
      { key: "thread:T2:2", action: "needs-human", reply: "" },
    ]);
  });
});
