import { describe, expect, test } from "bun:test";
import { applyHandoff, handoffMarkdown, nextAction, parseHandoff, parsePlan, planMarkdown, type TaskState } from "../src/index.ts";

const NOW = 1_000_000;
const raw = {
  summary: "Add discount codes to checkout.",
  steps: [
    { id: "model", title: "Discount model and validation", files: ["src/cart/discount.ts", "/etc/passwd", "../x"] },
    { id: "api", title: "Apply a code at checkout", files: ["src/api/checkout.ts"], check: "bun test src/api" },
  ],
  risks: ["Rounding on totals"],
};

describe("the plan", () => {
  test("a planner's answer becomes a plan; paths outside the repository are dropped", () => {
    const p = parsePlan(raw)!;
    expect(p.steps.map((s) => [s.id, s.status, s.files])).toEqual([
      ["model", "todo", ["src/cart/discount.ts"]],
      ["api", "todo", ["src/api/checkout.ts"]],
    ]);
    expect(planMarkdown("Discount codes", p)).toContain("- [ ] **api**: Apply a code at checkout\n  - files: src/api/checkout.ts\n  - check: bun test src/api");
  });

  test("step ids are normalized and made unique; not a plan without steps", () => {
    const p = parsePlan({ summary: "x", steps: [{ id: "Add findUserByEmail", title: "1" }, { id: "add_findUserByEmail", title: "2" }, { id: 3, title: "3" }, { id: "../", title: "4" }] })!;
    expect(p.steps.map((s) => s.id)).toEqual(["add-finduserbyemail", "add-finduserbyemail-2", "3", "step-4"]);
    expect(parsePlan({ summary: "x", steps: [] })).toBeUndefined();
    expect(parsePlan("just do it")).toBeUndefined();
  });
});

describe("what the task does next", () => {
  const start = (): TaskState => ({ id: "t1", stage: "building", plan: parsePlan(raw)!, handoffs: [], turns: 0, reviewRounds: 0 });

  test("plan, approval, then each step in order, then review and the pull request", () => {
    expect(nextAction({ id: "t1", stage: "planning", handoffs: [], turns: 0, reviewRounds: 0 }, NOW)).toEqual({ kind: "plan" });
    expect(nextAction({ ...start(), stage: "approval" }, NOW)).toEqual({ kind: "await-approval" });
    let t = start();
    expect(nextAction(t, NOW)).toMatchObject({ kind: "build", step: { id: "model" }, resume: false });
    t = applyHandoff(t, { role: "build", seat: "fast", at: NOW, done: ["model"], next: "wire the API", blockers: [], notes: "", files: ["src/cart/discount.ts"] });
    expect(t.plan!.steps.map((s) => s.status)).toEqual(["done", "doing"]);
    expect(nextAction(t, NOW)).toMatchObject({ kind: "build", step: { id: "api" }, resume: true });
    t = applyHandoff(t, { role: "build", seat: "fast", at: NOW, done: ["api"], next: "", blockers: [], notes: "", files: [] });
    expect(nextAction(t, NOW)).toEqual({ kind: "review", round: 1 });
    expect(nextAction({ ...t, stage: "reviewing", reviewRounds: 2 }, NOW)).toEqual({ kind: "open-pull-request" });
    expect(nextAction({ ...t, stage: "done" }, NOW)).toEqual({ kind: "stop" });
  });

  test("a seat cut off at its limit leaves the step under way for the next seat; a blocker stops and asks", () => {
    const cut = applyHandoff(start(), { role: "build", seat: "opus", at: NOW, done: [], next: "continue from the diff", blockers: [], notes: "", files: ["src/cart/discount.ts"], cut: "quota" });
    expect(cut.plan!.steps[0]!.status).toBe("doing");
    expect(nextAction({ ...cut, waitingUntil: NOW + 60_000 }, NOW)).toEqual({ kind: "wait", until: NOW + 60_000 });
    expect(nextAction(cut, NOW)).toMatchObject({ kind: "build", step: { id: "model" }, resume: true });
    expect(handoffMarkdown(cut.handoffs[0]!, cut.plan)).toContain("Cut off: quota. Written by Crewreview");
    const blocked = applyHandoff(start(), { role: "build", seat: "fast", at: NOW, done: [], next: "", blockers: ["Which currency rounding?"], notes: "", files: [] });
    expect(nextAction(blocked, NOW)).toEqual({ kind: "ask", reason: "blocked", step: "model" });
  });

  test("three turns that finish nothing, or too many turns, stop and ask instead of spinning", () => {
    let t = start();
    for (let i = 0; i < 3; i++) t = applyHandoff(t, { role: "build", seat: "fast", at: NOW, done: [], next: "keep going", blockers: [], notes: "", files: [] });
    expect(nextAction(t, NOW)).toEqual({ kind: "ask", reason: "no-progress", step: "model" });
    expect(nextAction({ ...start(), turns: 12 }, NOW)).toEqual({ kind: "ask", reason: "too-many-turns", step: "model" });
  });

  test("a handoff can only claim steps that are in the plan", () => {
    const plan = parsePlan(raw)!;
    expect(parseHandoff({ done: ["model", "nope", "model"], next: "api" }, plan)).toEqual({ done: ["model"], next: "api", blockers: [], notes: "" });
    expect(parseHandoff({ done: "model" }, plan)).toBeUndefined();
  });
});
