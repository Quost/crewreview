import { describe, expect, test } from "bun:test";
import { attendPrompt } from "../src/prompts.ts";

const base = { language: "English", owner: "quost", fix: true, dir: ".crewreview-attend" };

describe("attendant prompt: who decides trade-offs", () => {
  test("ask (the default) leaves a trade-off to the owner", () => {
    const p = attendPrompt(base);
    expect(p).toContain("needs a decision only quost can make");
    expect(p).not.toContain("You make the decisions");
    expect(attendPrompt({ ...base, decide: "ask" })).toBe(p);
  });

  test("own: the attendant decides from the written decisions and keeps needs-human for what it can't do", () => {
    const p = attendPrompt({ ...base, decide: "own" });
    expect(p).toContain("You make the decisions on this pull request");
    expect(p).toContain("follow the written decision");
    expect(p).toContain("say in the reply what you chose and why");
    expect(p).toContain("rewriting history, leaving draft, merging");
    expect(p).not.toContain("needs a decision only quost can make");
    // The file rules don't loosen.
    expect(p).toContain("never anything under ./.crewreview-attend/, CI configuration, secrets");
  });

  test("own has no effect when the attendant may only answer", () => {
    const p = attendPrompt({ ...base, fix: false, decide: "own" });
    expect(p).not.toContain("You make the decisions");
    expect(p).toContain("needs a code change or a decision by quost");
  });
});
