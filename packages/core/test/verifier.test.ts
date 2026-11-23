import { describe, expect, test } from "bun:test";
import { applyVerifier, requireScenario, unreadFindings, type FileOracle, type Finding } from "../src/index.ts";

const finding = (p: Partial<Finding> = {}): Finding => ({ id: "F1", lens: "correctness", lenses: ["correctness"], path: "lib/devices.ex", line: 10, severity: "nit", title: "t", body: "b", confidence: "medium", ...p });
const oracle: FileOracle = { lineCount: (p) => (p === "lib/station_live.ex" ? 2100 : p === "lib/devices.ex" ? 300 : null) };
const rules = { raise: true, raiseTo: "major" as const, oracle };

describe("the verifier raising a severity", () => {
  test("with a reason and a real place, a detail becomes a major; never past major", () => {
    const up = (severity: string, evidence = "lib/station_live.ex:1131") => applyVerifier([finding()], [{ id: "F1", action: "upgrade", severity: severity as Finding["severity"], evidence, reason: "The LiveView waits up to 7.5 s." }], rules).kept[0]!;
    expect(up("major")).toMatchObject({ severity: "major", verification: { action: "upgrade", from: "nit", evidence: "lib/station_live.ex:1131" } });
    // A blocker has to come from a lens.
    expect(up("blocker").severity).toBe("major");
    expect(up("major", "`lib/devices.ex:120-130`").severity).toBe("major");
  });

  test("without a real place, a reason, or permission, it stays as it was", () => {
    const keep = (d: Record<string, unknown>, r = rules) => applyVerifier([finding()], [{ id: "F1", action: "upgrade", severity: "major", reason: "worse", ...d } as never], r).kept[0]!;
    expect(keep({ evidence: "lib/station_live.ex:9999" }).severity).toBe("nit");
    expect(keep({ evidence: "lib/missing.ex:3" }).severity).toBe("nit");
    expect(keep({ evidence: "somewhere in the live view" }).severity).toBe("nit");
    expect(keep({ evidence: "lib/station_live.ex:1131", reason: " " }).severity).toBe("nit");
    expect(keep({ evidence: "lib/station_live.ex:1131" }, { ...rules, raise: false }).severity).toBe("nit");
    // The default, as before: nothing is ever raised.
    expect(applyVerifier([finding()], [{ id: "F1", action: "upgrade", severity: "major", evidence: "lib/devices.ex:3", reason: "x" }]).kept[0]!.severity).toBe("nit");
  });

  test("an upgrade to a severity the finding already has is just a confirm", () => {
    const r = applyVerifier([finding({ severity: "major" })], [{ id: "F1", action: "upgrade", severity: "minor", evidence: "lib/devices.ex:3", reason: "x" }], rules);
    expect(r.kept[0]).toMatchObject({ severity: "major", verification: { action: "confirm" } });
  });
});

describe("the verifier lowering a severity", () => {
  test("with the rules on, lowering needs the place that limits the impact; without it the severity stays", () => {
    const down = (evidence?: string) => applyVerifier([finding({ severity: "major" })], [{ id: "F1", action: "downgrade", severity: "nit", evidence, reason: "only on retry" }], rules).kept[0]!;
    expect(down()).toMatchObject({ severity: "major", verification: { action: "confirm" } });
    expect(down("lib/devices.ex:9999").severity).toBe("major");
    expect(down("lib/devices.ex:270")).toMatchObject({ severity: "nit", verification: { action: "downgrade", from: "major" } });
  });
});

describe("findings on files the lens didn't review", () => {
  test("are left out: its own answer says it didn't read them", () => {
    const r = unreadFindings([finding({ path: "lib/apply_worker.ex" }), finding({ id: "F2" })], ["head/lib/apply_worker.ex"]);
    expect(r).toEqual({ kept: [finding({ id: "F2" })], dropped: 1 });
  });
});

describe("a severe finding has to say how it goes wrong", () => {
  test("a blocker or major without a scenario is posted as minor, and says why", () => {
    const [a, b, c] = requireScenario([
      finding({ severity: "major" }),
      finding({ id: "F2", severity: "blocker", scenario: "With the flag off, a forged handle_event still writes to the device." }),
      finding({ id: "F3", severity: "nit" }),
    ]);
    expect(a).toMatchObject({ severity: "minor", capped: { from: "major", reason: "no-scenario" } });
    expect(b!.severity).toBe("blocker");
    expect(c!.severity).toBe("nit");
  });
});
