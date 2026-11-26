import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TASK_SKILLS } from "@crewreview/core";
import { BUILTIN_LENS_IDS, builtinSkills, skillBody } from "../src/index.ts";
import { renderPrompts } from "./fixtures/prompts/render.ts";

const fixture = (name: string) => readFile(join(import.meta.dir, "fixtures", "prompts", `${name}.txt`), "utf8");

describe("prompts keep their words", () => {
  test("review, verify, attend and plan render byte for byte as before", async () => {
    const out = await renderPrompts();
    for (const name of ["lens-correctness", "lens-docs", "verifier", "attend-fix-protected", "attend-nofix", "plan"]) {
      expect(out[name]).toBe(await fixture(name));
    }
  });

  test("build gains the relay section right before the rules, and nothing else", async () => {
    const out = (await renderPrompts()).build!;
    const block = `## How the crew hands off\n${skillBody("relay")}\n\nRules:`;
    expect(out).toContain(`\n\n${block}`);
    expect(out.replace(`${block.slice(0, -"Rules:".length)}`, "")).toBe(await fixture("build"));
  });
});

describe("skills registry", () => {
  const all = builtinSkills();

  test("the five skills, then every lens", () => {
    expect(all.slice(0, 5).map((s) => s.id).sort()).toEqual(["attend", "plan", "relay", "review", "verify"]);
    expect(all.find((s) => s.id === "relay")).toMatchObject({ kind: "method", roles: ["build"] });
    for (const id of BUILTIN_LENS_IDS) {
      const s = all.find((x) => x.id === `lens-${id}`);
      expect(s).toMatchObject({ kind: "lens", roles: ["review"], source: "builtin" });
      expect(s!.body.length).toBeGreaterThan(0);
      expect(s!.description).not.toContain("\n");
      expect(s!.description.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique and every skill has its texts", () => {
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    for (const s of all) expect([s.title, s.description, s.body].every((t) => t.trim().length > 0)).toBe(true);
  });

  test("every task skill exists", () => {
    const ids = all.map((s) => s.id);
    for (const id of TASK_SKILLS) expect(ids).toContain(id);
  });
});
