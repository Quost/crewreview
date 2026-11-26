/** Skills: the instructions an agent role follows, kept as files (one folder, one SKILL.md). Pure parsing, no I/O. */

export type SkillKind = "role" | "method" | "lens";
export type SkillRole = "review" | "verify" | "attend" | "plan" | "build";

export interface Skill {
  id: string;
  title: string;
  description: string;
  kind: SkillKind;
  roles: SkillRole[];
  source: "builtin";
  body: string;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ROLES: readonly SkillRole[] = ["review", "verify", "attend", "plan", "build"];
const KEYS = ["name", "title", "description", "kind", "roles"] as const;

/** The skills a crew mode task uses, in the order its agents meet them. */
export const TASK_SKILLS = ["plan", "relay", "review", "verify"] as const;

/**
 * Reads a SKILL.md: frontmatter between a first `---` line and the next one (`key: value`, one per line), then the
 * body. `id` is the folder name and must equal `name`. Lenses are not skills on disk, so `kind: lens` is refused.
 */
export function parseSkill(text: string, id: string): Skill | { error: string } {
  if (!ID.test(id)) return { error: "bad-id" };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { error: "no-frontmatter" };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { error: "no-frontmatter" };
  const meta = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m) meta.set(m[1]!, m[2]!.trim());
  }
  for (const key of KEYS) if (!meta.get(key)) return { error: `missing:${key}` };
  if (meta.get("name") !== id) return { error: "name-mismatch" };
  const kind = meta.get("kind");
  if (kind !== "role" && kind !== "method") return { error: "bad-kind" };
  const roles = meta
    .get("roles")!
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!roles.length || !roles.every((r): r is SkillRole => (ROLES as readonly string[]).includes(r))) return { error: "bad-role" };
  const body = lines.slice(end + 1).join("\n").trim();
  if (!body) return { error: "empty-body" };
  return { id, title: meta.get("title")!, description: meta.get("description")!, kind, roles: roles as SkillRole[], source: "builtin", body };
}
