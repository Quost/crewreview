import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalCases } from "../src/index.ts";

test("calibration cases are read from any depth; a broken one is reported, not fatal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-eval-"));
  try {
    await mkdir(join(dir, "shop"), { recursive: true });
    const ok = { id: "shop-12", repo: "acme-shop", number: 12, head: "27d3bcf0", base: "9d9cfe60", must: [{ id: "x", any: ["sleep"] }] };
    await writeFile(join(dir, "shop", "12.case.json"), JSON.stringify(ok));
    await writeFile(join(dir, "broken.case.json"), "{ not json");
    await writeFile(join(dir, "notes.json"), JSON.stringify({ ignored: true }));
    const r = await loadEvalCases(dir);
    expect(r.cases.map((x) => x.case.id)).toEqual(["shop-12"]);
    expect(r.errors.map((e) => e.file)).toEqual([join(dir, "broken.case.json")]);
    expect(await loadEvalCases(join(dir, "missing"))).toEqual({ cases: [], errors: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
