import { describe, expect, test } from "bun:test";
import { applyVerifier, unreadFindings, type FileOracle, type Finding } from "../src/index.ts";

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

describe("findings on files the lens didn't review", () => {
  test("are left out: its own answer says it didn't read them", () => {
    const r = unreadFindings([finding({ path: "lib/apply_worker.ex" }), finding({ id: "F2" })], ["head/lib/apply_worker.ex"]);
    expect(r).toEqual({ kept: [finding({ id: "F2" })], dropped: 1 });
  });
});
