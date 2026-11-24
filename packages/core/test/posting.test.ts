import { describe, expect, test } from "bun:test";
import { planPost, type Finding, type PostPlanInput } from "../src/index.ts";

const f = (id: string, severity: Finding["severity"], p: Partial<Finding> = {}): Finding => ({
  id,
  lens: "correctness",
  lenses: ["correctness"],
  path: "a.ts",
  line: 1,
  severity,
  title: id,
  body: "b",
  confidence: "high",
  ...p,
});
const base: PostPlanInput = { findings: [], repeated: [], maxNits: Number.POSITIVE_INFINITY, verifierDropped: 0, droppedByEvidence: 0, droppedUnread: 0 };
const ids = (l: readonly Finding[]) => l.map((x) => x.id);

describe("what a review posts and what it leaves out", () => {
  test("a first review with nothing left out says nothing about it", () => {
    const plan = planPost({ ...base, findings: [f("F1", "major"), f("F2", "nit")] });
    expect(ids(plan.posted)).toEqual(["F1", "F2"]);
    expect(plan.leftOut).toEqual([]);
    expect(plan.stillOpen).toEqual([]);
  });

  test("nits past the cap are listed, counted, and the cap is named", () => {
    const plan = planPost({ ...base, maxNits: 1, findings: [f("F1", "nit"), f("F2", "nit"), f("F3", "nit"), f("F4", "minor")] });
    expect(ids(plan.posted)).toEqual(["F1", "F4"]);
    expect(ids(plan.extraNits)).toEqual(["F2", "F3"]);
    expect(plan.leftOut).toEqual([{ reason: "over-nit-cap", count: 2, cap: 1 }]);
  });

  test("a cap of zero lists every nit; a negative cap counts as zero", () => {
    const plan = planPost({ ...base, maxNits: -3, findings: [f("F1", "nit")] });
    expect(ids(plan.extraNits)).toEqual(["F1"]);
    expect(plan.leftOut).toEqual([{ reason: "over-nit-cap", count: 1, cap: 0 }]);
  });

  test("low confidence is asked, not posted, unless it's already past the nit cap", () => {
    const plan = planPost({ ...base, maxNits: 0, findings: [f("F1", "major", { confidence: "low" }), f("F2", "nit", { confidence: "low" })] });
    expect(ids(plan.unconfirmed)).toEqual(["F1"]);
    expect(ids(plan.extraNits)).toEqual(["F2"]);
    expect(plan.posted).toEqual([]);
  });

  test("a re-review counts what it didn't repeat, by severity, and names only the serious ones again", () => {
    const repeated = [f("R1", "minor"), f("R2", "major"), f("R3", "minor"), f("R4", "nit")];
    const plan = planPost({ ...base, findings: [f("F1", "minor")], repeated });
    expect(ids(plan.posted)).toEqual(["F1"]);
    expect(ids(plan.stillOpen)).toEqual(["R2"]);
    expect(plan.leftOut).toEqual([
      {
        reason: "already-raised",
        count: 4,
        severities: [
          { severity: "major", count: 1 },
          { severity: "minor", count: 2 },
          { severity: "nit", count: 1 },
        ],
      },
    ]);
  });

  test("every reason gets one entry, in a fixed order", () => {
    const plan = planPost({ ...base, maxNits: 0, findings: [f("F1", "nit")], repeated: [f("R1", "blocker")], verifierDropped: 2, droppedByEvidence: 3, droppedUnread: 1 });
    expect(plan.leftOut.map((l) => [l.reason, l.count])).toEqual([
      ["already-raised", 1],
      ["over-nit-cap", 1],
      ["no-evidence", 3],
      ["unread", 1],
      ["verifier", 2],
    ]);
  });
});
