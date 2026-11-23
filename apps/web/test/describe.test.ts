import { describe as group, expect, test } from "bun:test";
import { createTranslator } from "@crewreview/i18n";
import { describe, describeEntry, foldQuiet } from "../src/describe.ts";

const t = createTranslator("en");
const cycle = (at: number, extra: Record<string, unknown> = {}) => ({ at, event: { type: "cycle", repos: 8, reviewed: 0, waiting: 0, ...extra } });

group("activity log", () => {
  test("empty checks in a row become one line, with how many and since when", () => {
    const skip = { at: 4, event: { type: "skip", repo: "acme-shop", number: 1, reason: "draft" } };
    const folded = foldQuiet([cycle(1), cycle(2), cycle(3), skip, cycle(5), cycle(6, { reviewed: 1 }), cycle(7, { repos: 9 })]);
    expect(folded.map((e) => [e.at, e.quiet?.count ?? 1])).toEqual([
      [3, 3],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
    ]);
    expect(folded[0]!.quiet?.since).toBe(1);
    expect(describeEntry(t, folded[0]!).text).toContain("3 times since");
  });

  test("a check that couldn't reach a host says so instead of looking like an empty one", () => {
    const e = cycle(1, { repos: 0, offline: ["acme", "other-y"] });
    expect(foldQuiet([e, cycle(2, { repos: 0, offline: ["acme"] })])).toHaveLength(2);
    const line = describe(t, e.event);
    expect(line.tone).toBe("warn");
    expect(line.text).toContain("No connection to acme, other-y");
  });

  test("each harness problem says its own way out", () => {
    const line = (error: unknown) => describe(t, { type: "attend-outcome", repo: "acme-shop", number: 616, outcome: { kind: "harness", error } }).text;
    expect(line({ error: "needs-write-check", name: "kiro" })).toBe(t.t("web.log.needsProof", { repo: "acme-shop", number: 616, name: "kiro" }));
    expect(line({ error: "write-escapes", name: "kiro" })).toBe(`acme-shop#616: ${t.t("error.writeEscapes", { name: "kiro" })}`);
    expect(line({ error: "no-harness" })).toBe(`acme-shop#616: ${t.t("error.noHarness")}`);
    expect(line({ error: "not-read-only", name: "x" })).toBe(`acme-shop#616: ${t.t("error.harnessNotReadOnly", { name: "x" })}`);
  });
});
