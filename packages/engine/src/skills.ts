import { parseSkill, type Skill } from "@crewreview/core";
import attend from "../skills/attend/SKILL.md" with { type: "text" };
import plan from "../skills/plan/SKILL.md" with { type: "text" };
import relay from "../skills/relay/SKILL.md" with { type: "text" };
import review from "../skills/review/SKILL.md" with { type: "text" };
import verify from "../skills/verify/SKILL.md" with { type: "text" };
import { builtinLenses } from "./lenses.ts";

export type SkillId = "review" | "verify" | "attend" | "plan" | "relay";

const FILES: Record<SkillId, string> = { review, verify, attend, plan, relay };

const SKILLS = new Map<SkillId, Skill>(
  (Object.keys(FILES) as SkillId[]).map((id) => {
    const s = parseSkill(FILES[id], id);
    if ("error" in s) throw new Error(`skill ${id}: ${s.error}`);
    return [id, s];
  }),
);

/** The method text of a skill, as the prompts insert it. */
export function skillBody(id: SkillId): string {
  return SKILLS.get(id)!.body;
}

/** The first paragraph of a rubric that isn't a heading, on one line. */
function describeRubric(rubric: string): string {
  for (const para of rubric.split(/\r?\n\s*\r?\n/)) {
    const t = para.trim();
    if (t && !t.startsWith("#")) return t.replace(/\s*\r?\n\s*/g, " ");
  }
  return "";
}

/** Every built-in skill: the five from `skills/`, then one per built-in lens. */
export function builtinSkills(): Skill[] {
  return [
    ...SKILLS.values(),
    ...builtinLenses().map(
      (l): Skill => ({ id: `lens-${l.id}`, title: l.title, description: describeRubric(l.rubric), kind: "lens", roles: ["review"], source: "builtin", body: l.rubric.trim() }),
    ),
  ];
}
