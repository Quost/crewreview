import { describe, expect, test } from "bun:test";
import { matchesExpectation, parseEvalCase, scoreEval, summarizeEval } from "../src/index.ts";

const f = (path: string, title: string, severity: "blocker" | "major" | "minor" | "nit" = "major", body = "") => ({ path, title, body, severity });
const base = { id: "shop-12", repo: "acme-shop", number: 12, head: "27d3bcf0", base: "9d9cfe60" };

describe("calibration cases", () => {
  test("a case needs its pinned commits and valid expectations", () => {
    expect(parseEvalCase({ ...base, must: [{ id: "x", any: ["sleep"] }] }).ok).toBe(true);
    const bad = parseEvalCase({ ...base, head: "main", must: [{ id: "x", any: [] }] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("head");
  });

  test("a finding matches on the file's end and any word, ignoring case and accents", () => {
    const e = { id: "block", file: "live/station_live.ex", any: ["bloqueia", "sleep"] };
    expect(matchesExpectation(f("lib/app/live/station_live.ex", "Releitura BLOQUEIA o processo"), e)).toBe(true);
    expect(matchesExpectation(f("lib/app/live/station_live.ex", "Não trata :unconfirmed", "major", "usa Process.sleep"), e)).toBe(true);
    expect(matchesExpectation(f("lib/app/worker.ex", "bloqueia"), e)).toBe(false);
    expect(matchesExpectation(f("a.ex", "Sessão expirada"), { id: "s", any: ["sessao"] })).toBe(true);
    // A second group: the finding must say something about it, not only name it.
    const both = { id: "u", any: [":unconfirmed"], also: ["station_live", "chamador"] };
    expect(matchesExpectation(f("a.ex", ":unconfirmed sem teste"), both)).toBe(false);
    expect(matchesExpectation(f("a.ex", ":unconfirmed não tratado pelos chamadores"), both)).toBe(true);
  });

  test("the score says what was found, missed and wrongly claimed, and how noisy it was", () => {
    const c = { ...base, must: [{ id: "block", any: ["sleep"] }, { id: "unconfirmed", any: [":unconfirmed"] }], mustNot: [{ id: "dom-id", any: ["dom id"] }] };
    const s = scoreEval(c, [f("a.ex", "sleep na releitura"), f("b.ex", "DOM id pode ficar vazio", "minor"), f("c.ex", "nome", "nit")]);
    expect(s).toMatchObject({ found: ["block"], underrated: [], missed: ["unconfirmed"], falsePositives: ["dom-id"], recall: 0.5, findings: 3, bySeverity: { major: 1, minor: 1, nit: 1 } });
    expect(scoreEval({ ...base, must: [], mustNot: [] }, []).recall).toBe(1);
  });

  test("the summary counts recall over every expectation, not an average of averages", () => {
    const a = scoreEval({ ...base, id: "a", must: [{ id: "1", any: ["x"] }], mustNot: [] }, [f("a", "x", "nit")]);
    const b = scoreEval({ ...base, id: "b", must: [{ id: "1", any: ["y"] }, { id: "2", any: ["z"] }, { id: "3", any: ["w"] }], mustNot: [] }, []);
    expect(summarizeEval([a, b])).toEqual({ cases: 2, recall: 0.25, underrated: 0, falsePositives: 0, findingsPerReview: 0.5, smallPerReview: 0.5 });
  });

  test("a real risk posted as a detail is underrated, not found", () => {
    const c = { ...base, must: [{ id: "block", any: ["sleep"], atLeast: "major" as const }], mustNot: [] };
    expect(scoreEval(c, [f("a.ex", "sleep na releitura", "nit")])).toMatchObject({ found: [], underrated: ["block"], missed: [], recall: 0 });
    expect(scoreEval(c, [f("a.ex", "sleep na releitura", "blocker")])).toMatchObject({ found: ["block"], underrated: [] });
  });
});
