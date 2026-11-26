import { loadLenses } from "../../../src/lenses.ts";
import { attendPrompt, buildPrompt, lensPrompt, planPrompt, verifierPrompt } from "../../../src/prompts.ts";

const ctx = { language: "English", nonce: "abc123" };
const guide = { path: "REVIEW.md", text: "Skip generated files." };
const task = { owner: "ana", language: "English", dir: ".crewreview" };
const step = { id: "add-model", title: "Add the model", detail: "Create the table.", files: ["src/model.ts"], check: "bun test" };

/** Renders every prompt the skills touch, with fixed inputs. */
export async function renderPrompts(): Promise<Record<string, string>> {
  const lenses = await loadLenses("/nonexistent-crewreview-root", "worktree");
  const byId = (id: string) => lenses.find((l) => l.id === id)!;
  return {
    "lens-correctness": lensPrompt(byId("correctness"), ctx),
    "lens-docs": lensPrompt(byId("docs"), { ...ctx, reviewGuide: guide }),
    verifier: verifierPrompt({ ...ctx, reviewGuide: guide }),
    "attend-fix-protected": attendPrompt({ language: "English", owner: "ana", fix: true, dir: ".crewreview", protectedFiles: [".github/workflows/ci.yml"], protectedMode: "approve" }),
    "attend-nofix": attendPrompt({ language: "English", owner: "ana", fix: false, dir: ".crewreview" }),
    plan: planPrompt(task),
    build: buildPrompt({ ...task, step, resume: false }),
  };
}
