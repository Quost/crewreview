import { describe, expect, test } from "bun:test";
import { behindService, linkSpent, shouldLinkCommand, stackOrder, stackParents, syncItem, syncPlan, type StackPr } from "../src/index.ts";

const pr = (number: number, headRef: string, baseRef: string, fromFork = false): StackPr => ({ number, headRef, baseRef, headSha: `h${number}`, fromFork });

describe("stacks", () => {
  test("a pull request sits on the one whose branch is its base", () => {
    const prs = [pr(606, "c", "b"), pr(605, "b", "a"), pr(604, "a", "develop"), pr(700, "x", "develop")];
    const parents = stackParents(prs);
    expect(parents.get(606)?.number).toBe(605);
    expect(parents.get(605)?.number).toBe(604);
    expect(parents.has(604)).toBe(false);
    expect(parents.has(700)).toBe(false);
  });

  test("forks never stack", () => {
    expect(stackParents([pr(2, "b", "a"), pr(1, "a", "main", true)]).size).toBe(0);
    expect(stackParents([pr(2, "b", "a", true), pr(1, "a", "main")]).size).toBe(0);
  });

  test("the bottom of a stack comes first, the rest keeps its order", () => {
    const prs = [pr(606, "c", "b"), pr(700, "x", "develop"), pr(605, "b", "a"), pr(604, "a", "develop")];
    expect(stackOrder(prs).map((p) => p.number)).toEqual([604, 605, 606, 700]);
  });

  test("a loop doesn't hang or drop anyone", () => {
    const order = stackOrder([pr(1, "a", "b"), pr(2, "b", "a")]).map((p) => p.number);
    expect(order.sort()).toEqual([1, 2]);
  });
});

describe("syncPlan", () => {
  const link = { parent: 605, parentRef: "b", parentSha: "p605" };

  test("nothing to do when the base is already in the branch", () => {
    expect(syncPlan({ baseRef: "b", parent: { number: 605 }, behind: false, linkInHead: true })).toEqual({ kind: "none" });
  });

  test("a stacked branch behind the one below takes it in", () => {
    expect(syncPlan({ baseRef: "b", parent: { number: 605 }, link, behind: true, linkInHead: true })).toEqual({ kind: "merge", why: "stacked", parent: 605 });
  });

  test("after the one below is merged, the base comes in compared from its last head", () => {
    expect(syncPlan({ baseRef: "develop", link, behind: true, linkInHead: true })).toEqual({ kind: "merge", why: "restack", parent: 605, mergeBase: "p605" });
  });

  test("a branch not built on the last head seen gets the usual conflict handling", () => {
    expect(syncPlan({ baseRef: "develop", link, behind: true, linkInHead: false })).toEqual({ kind: "none" });
  });

  test("a branch that isn't stacked is left to the usual conflict handling", () => {
    expect(syncPlan({ baseRef: "develop", behind: true, linkInHead: false })).toEqual({ kind: "none" });
  });

  test("the link is spent once the branch took its new base in, or wasn't built on it", () => {
    expect(linkSpent({ baseRef: "develop", link, behind: false, linkInHead: true })).toBe(true);
    expect(linkSpent({ baseRef: "develop", link, behind: true, linkInHead: false })).toBe(true);
    expect(linkSpent({ baseRef: "develop", link, behind: true, linkInHead: true })).toBe(false);
    expect(linkSpent({ baseRef: "b", link, behind: false, linkInHead: true })).toBe(false);
  });
});

describe("syncItem", () => {
  const s = { headSha: "h606", baseSha: "b1", baseRef: "b" };

  test("one item per pair of commits, merged like a conflict", () => {
    const it = syncItem({ kind: "merge", why: "stacked", parent: 605 }, s, new Set());
    expect(it?.key).toBe("sync:h606:b1");
    expect(it?.kind).toBe("conflict");
    expect(it?.text).toContain("#605");
    expect(syncItem({ kind: "merge", why: "stacked", parent: 605 }, s, new Set(["sync:h606:b1"]))).toBeUndefined();
  });

  test("after a merge below, it says the base was compared from that pull request's last head", () => {
    const it = syncItem({ kind: "merge", why: "restack", parent: 605, mergeBase: "p605" }, { ...s, baseRef: "develop" }, new Set());
    expect(it?.text).toContain("has been merged");
    expect(it?.text).toContain("develop");
  });
});

describe("one crewreview for app and terminal", () => {
  const app = "/Applications/Crewreview.app/Contents/MacOS/crewreview";

  test("a terminal copy older than the running service is behind; no service, nothing to compare", () => {
    expect(behindService("0.14.1", "0.15.0")).toBe(true);
    expect(behindService("0.15.0", "0.15.0")).toBe(false);
    expect(behindService("0.16.0", "0.15.0")).toBe(false);
    expect(behindService("0.15.0", undefined)).toBe(false);
  });

  test("the app takes over a copy of its own or a link to an app that moved, nothing else", () => {
    expect(shouldLinkCommand({ kind: "file", version: "0.14.1" }, app)).toBe(true);
    expect(shouldLinkCommand({ kind: "file" }, app)).toBe(false); // not Crewreview, or it didn't answer
    expect(shouldLinkCommand({ kind: "missing" }, app)).toBe(false);
    expect(shouldLinkCommand({ kind: "link", target: app, exists: true }, app)).toBe(false);
    expect(shouldLinkCommand({ kind: "link", target: "/Users/me/Downloads/Crewreview.app/Contents/MacOS/crewreview", exists: true }, app)).toBe(true);
    expect(shouldLinkCommand({ kind: "link", target: "/gone/crewreview", exists: false }, app)).toBe(true);
    expect(shouldLinkCommand({ kind: "link", target: "/opt/homebrew/Cellar/crewreview/0.15.0/bin/crewreview", exists: true }, app)).toBe(false);
  });
});
