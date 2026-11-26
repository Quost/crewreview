import { describe, expect, test } from "bun:test";
import { parseSkill, TASK_SKILLS } from "../src/index.ts";

const file = (over: Record<string, string | null> = {}, body = "Do the thing.\nThen stop.") => {
  const meta: Record<string, string | null> = { name: "plan", title: "Planning", description: "Plans the work.", kind: "role", roles: "plan", ...over };
  const lines = Object.entries(meta).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
};

describe("parseSkill", () => {
  test("a valid file", () => {
    expect(parseSkill(file(), "plan")).toEqual({
      id: "plan",
      title: "Planning",
      description: "Plans the work.",
      kind: "role",
      roles: ["plan"],
      source: "builtin",
      body: "Do the thing.\nThen stop.",
    });
  });

  test("CRLF line endings", () => {
    const s = parseSkill(file().replace(/\n/g, "\r\n"), "plan");
    expect(s).toMatchObject({ id: "plan", title: "Planning", body: "Do the thing.\nThen stop." });
  });

  test("roles with spaces", () => {
    const s = parseSkill(file({ roles: "review ,  verify, build" }), "plan");
    expect("error" in s ? s.error : s.roles).toEqual(["review", "verify", "build"]);
  });

  test("method kind", () => {
    expect(parseSkill(file({ kind: "method" }), "plan")).toMatchObject({ kind: "method" });
  });

  test("errors", () => {
    expect(parseSkill(file(), "Plan")).toEqual({ error: "bad-id" });
    expect(parseSkill(file(), "-plan")).toEqual({ error: "bad-id" });
    expect(parseSkill("Just text.\n", "plan")).toEqual({ error: "no-frontmatter" });
    expect(parseSkill("---\nname: plan\nno end", "plan")).toEqual({ error: "no-frontmatter" });
    expect(parseSkill(file({ name: "other" }), "plan")).toEqual({ error: "name-mismatch" });
    expect(parseSkill(file({ kind: "lens" }), "plan")).toEqual({ error: "bad-kind" });
    expect(parseSkill(file({ kind: "tool" }), "plan")).toEqual({ error: "bad-kind" });
    expect(parseSkill(file({ roles: "plan, deploy" }), "plan")).toEqual({ error: "bad-role" });
    expect(parseSkill(file({ title: null }), "plan")).toEqual({ error: "missing:title" });
    expect(parseSkill(file({ description: null }), "plan")).toEqual({ error: "missing:description" });
    expect(parseSkill(file({ roles: null }), "plan")).toEqual({ error: "missing:roles" });
    expect(parseSkill(file({}, "   "), "plan")).toEqual({ error: "empty-body" });
  });
});

test("TASK_SKILLS", () => {
  expect([...TASK_SKILLS]).toEqual(["plan", "relay", "review", "verify"]);
});
