import { describe, expect, test } from "bun:test";
import { heldPaths, leftForOwner, makeMarker, parseAttendOutput, pendingItems, protectedFilesToEdit, sensitivePaths, settled, situationItems, type AttendRules, type AttendThread } from "../src/index.ts";

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

describe("the pull request's own state", () => {
  const on = { conflicts: true, ci: true };
  test("a conflict and a red CI become items for this head, only when the repository asks", () => {
    const items = situationItems({ headSha: "abc", baseRef: "main", conflicts: true, failing: [{ name: "test", log: "expected 2, got 3" }, { name: "lint" }] }, on, new Set());
    expect(items.map((i) => [i.key, i.kind])).toEqual([["conflict:abc", "conflict"], ["ci:abc", "ci"]]);
    expect(items[1]!.text).toContain('Job "test" failed. From its log:\nexpected 2, got 3');
    expect(items[1]!.text).toContain('Job "lint" failed (no log available).');
    // Not anyone's comment: never holds up the wait for a review to land.
    expect(settled(items, Date.now(), 45_000)).toBe(true);
    expect(situationItems({ headSha: "abc", baseRef: "main", conflicts: true, failing: [{ name: "t" }] }, { conflicts: false, ci: false }, new Set())).toEqual([]);
  });

  test("unknown or clean stays quiet; a handled head doesn't come back, a new push does", () => {
    expect(situationItems({ headSha: "abc", baseRef: "main", conflicts: undefined, failing: [] }, on, new Set())).toEqual([]);
    expect(situationItems({ headSha: "abc", baseRef: "main", conflicts: true }, on, new Set(["conflict:abc"]))).toEqual([]);
    expect(situationItems({ headSha: "def", baseRef: "main", conflicts: true }, on, new Set(["conflict:abc"]))[0]?.key).toBe("conflict:def");
  });
});


describe("what the attendant may change, and what it leaves you", () => {
  const item = (key: string, path?: string, line?: number, kind: "thread" | "conflict" | "review" = "thread", author = "bia") => ({ key, kind, path, line, author, text: "", createdAt: "", fromCrew: false });

  test("protected files a reviewer commented on may be changed; secrets and the crew's folder never", () => {
    const items = [item("a", "AGENTS.md", 44), item("b", ".github/workflows/ci.yml", 3), item("c", ".env", 1), item("d", ".crewreview/x.md", 1), item("e", "src/a.ts", 1), item("f", "AGENTS.md", 50)];
    expect(protectedFilesToEdit(items)).toEqual(["AGENTS.md", ".github/workflows/ci.yml"]);
  });

  test("approve holds every protected change; auto lets the commented ones go out, never the others", () => {
    expect(heldPaths(["AGENTS.md", "src/a.ts"], ["AGENTS.md"], "approve")).toEqual(["AGENTS.md"]);
    expect(heldPaths(["AGENTS.md", "src/a.ts"], ["AGENTS.md"], "auto")).toEqual([]);
    expect(heldPaths(["AGENTS.md", "CLAUDE.md"], ["AGENTS.md"], "auto")).toEqual(["CLAUDE.md"]);
  });

  test("the items left for you, with where they are", () => {
    const items = [item("a", "AGENTS.md", 44), item("b", "src/a.ts", 3), item("c", undefined, undefined, "review", "lewalmeida"), item("d", undefined, undefined, "conflict", "")];
    const left = leftForOwner(items, [
      { key: "a", action: "needs-human", reply: "" },
      { key: "b", action: "fixed", reply: "done" },
      { key: "c", action: "needs-human", reply: "" },
      { key: "d", action: "needs-human", reply: "" },
    ]);
    expect(left).toEqual([{ kind: "thread", path: "AGENTS.md", line: 44, author: "bia" }, { kind: "review", author: "lewalmeida" }, { kind: "conflict" }]);
  });
});
