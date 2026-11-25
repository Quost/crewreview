import { describe, expect, test } from "bun:test";
import { firstSentence, heldPaths, leftForOwner, parseMarker, roundSummary, makeMarker, parseAttendOutput, parseRawDiff, pendingItems, protectedFilesToEdit, sensitivePaths, settled, situationItems, specialModePaths, type AttendRules, type AttendThread } from "../src/index.ts";

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

  test("git's own files and agent configuration are protected", () => {
    const paths = [".gitattributes", "lib/.gitattributes", ".gitmodules", ".mcp.json", "tools/.mcp.json", ".claude/settings.json", ".claude/commands/x.md", "pkg/.claude/agents/a.md"];
    expect(sensitivePaths(paths)).toEqual(paths);
    expect(sensitivePaths(["src/claude/x.ts", "mcp.json", "docs/gitmodules.md", "src/.claudeignore"])).toEqual([]);
    // Like CLAUDE.md: they wait for you, and a reviewer's comment on them lets the attendant act.
    expect(heldPaths([".claude/settings.json", ".mcp.json"], [], "approve")).toEqual([".claude/settings.json", ".mcp.json"]);
    expect(protectedFilesToEdit([item("a", ".gitmodules", 1), item("b", ".claude/settings.json", 2)])).toEqual([".gitmodules", ".claude/settings.json"]);
  });

  test("git diff --raw: modes before and after, renames by their new name", () => {
    const raw = [
      ":000000 120000 0000000 a1b2c3d A", "docs/link",
      ":100644 100644 1111111 2222222 M", "src/a.ts",
      ":000000 160000 0000000 e4f5a6b A", "vendor/lib",
      ":100644 120000 3333333 4444444 T", "config.yml",
      ":120000 000000 5555555 0000000 D", "old-link",
      ":100644 100644 6666666 7777777 R087", "src/old.ts", "src/new.ts",
      "not an entry",
      "",
    ].join("\0");
    expect(parseRawDiff(raw)).toEqual([
      { path: "docs/link", oldMode: "000000", newMode: "120000" },
      { path: "src/a.ts", oldMode: "100644", newMode: "100644" },
      { path: "vendor/lib", oldMode: "000000", newMode: "160000" },
      { path: "config.yml", oldMode: "100644", newMode: "120000" },
      { path: "old-link", oldMode: "120000", newMode: "000000" },
      { path: "src/new.ts", oldMode: "100644", newMode: "100644" },
    ]);
    expect(specialModePaths(parseRawDiff(raw))).toEqual(["docs/link", "vendor/lib", "config.yml", "old-link"]);
    expect(parseRawDiff("")).toEqual([]);
  });

  test("symlinks and submodules always wait: neither auto nor a reviewer's comment releases them", () => {
    const changes = [
      { path: "src/link.ts", oldMode: "000000", newMode: "120000" },
      { path: "vendor/lib", oldMode: "160000", newMode: "160000" },
      { path: "src/a.ts", oldMode: "100644", newMode: "100755" },
    ];
    const special = specialModePaths(changes);
    expect(special).toEqual(["src/link.ts", "vendor/lib"]);
    const changed = ["src/link.ts", "vendor/lib", "src/a.ts"];
    expect(heldPaths(changed, [], "approve", special)).toEqual(["src/link.ts", "vendor/lib"]);
    expect(heldPaths(changed, ["src/link.ts", "vendor/lib"], "auto", special)).toEqual(["src/link.ts", "vendor/lib"]);
    // A protected path that's also a link: the comment releases the path rule, never the link.
    expect(heldPaths(["AGENTS.md"], ["AGENTS.md"], "auto", ["AGENTS.md"])).toEqual(["AGENTS.md"]);
    // An executable bit alone is an ordinary change.
    expect(heldPaths(["src/a.ts"], [], "auto", specialModePaths([changes[2]!]))).toEqual([]);
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

describe("a round's summary", () => {
  const item = (key: string, extra: object = {}) => ({ key, kind: "thread" as const, author: "bia", text: "", createdAt: "", fromCrew: false, ...extra });
  const items = [item("a", { path: "src/a.ts", line: 3 }), item("b", { path: "src/b.ts", line: 9 }), item("c", { kind: "review" as const })];

  test("only when the round touched at least two items", () => {
    expect(roundSummary(items, [{ key: "a", action: "fixed", reply: "Done." }])).toBeUndefined();
    expect(roundSummary(items, [{ key: "a", action: "fixed", reply: "Done." }], 1)).toHaveLength(1);
  });

  test("says where each item was, and why for the declined and the left ones", () => {
    const lines = roundSummary(items, [
      { key: "a", action: "fixed", reply: "Moved the comment. Also renamed x." },
      { key: "b", action: "declined", reply: "Out of scope here. A follow-up covers it." },
      { key: "c", action: "needs-human", reply: "This changes the product rule.\nYour call." },
      { key: "gone", action: "fixed", reply: "x" },
    ])!;
    expect(lines).toEqual([
      { action: "fixed", kind: "thread", path: "src/a.ts", line: 3, author: "bia" },
      { action: "declined", kind: "thread", path: "src/b.ts", line: 9, author: "bia", reason: "Out of scope here." },
      { action: "needs-human", kind: "review", author: "bia", reason: "This changes the product rule." },
    ]);
  });

  test("a reason is one sentence on one line, cut to its limit", () => {
    expect(firstSentence("  one\n two. three")).toBe("one two.");
    expect(firstSentence("v1.2 is out")).toBe("v1.2 is out");
    expect(firstSentence("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("its marker is told apart from the others", () => {
    expect(parseMarker(makeMarker({ kind: "round", ref: "671", version: "1" }))).toEqual({ kind: "round", ref: "671", version: "1" });
  });
});
