import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffFile } from "@crewreview/core";
import architecture from "../lenses/architecture.md" with { type: "text" };
import contracts from "../lenses/contracts.md" with { type: "text" };
import correctness from "../lenses/correctness.md" with { type: "text" };
import docs from "../lenses/docs.md" with { type: "text" };
import security from "../lenses/security.md" with { type: "text" };
import tests from "../lenses/tests.md" with { type: "text" };
import ui from "../lenses/ui.md" with { type: "text" };
import { listDir, showFile } from "./git.ts";

export interface Lens {
  id: string;
  title: string;
  rubric: string;
  /** Where the rubric came from: built in, or the repository's `.crewreview/lenses/`. */
  source: "builtin" | "repo";
  applies(files: readonly DiffFile[]): boolean;
  /** Also answers the claims and project rules it checked, posted as a list. */
  checks?: boolean;
}

const DOC = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(LICENSE|NOTICE|AUTHORS|CHANGELOG)[^/]*$/i;
const UI =
  /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|heex|leex|erb|haml|slim|swift|xib|storyboard|kt|dart|xaml)$|(^|\/)(components?|views?|screens?|pages?|ui|styles?|layouts?|templates?)\//i;

const onlyDocs = (files: readonly DiffFile[]) => files.length > 0 && files.every((f) => DOC.test(f.path));

const BUILTIN: Lens[] = [
  { id: "correctness", title: "Correctness", rubric: correctness, source: "builtin", applies: () => true },
  { id: "contracts", title: "Contracts", rubric: contracts, source: "builtin", applies: (f) => !onlyDocs(f) },
  { id: "security", title: "Security", rubric: security, source: "builtin", applies: (f) => !onlyDocs(f) },
  { id: "architecture", title: "Architecture", rubric: architecture, source: "builtin", applies: (f) => !onlyDocs(f) },
  { id: "tests", title: "Tests", rubric: tests, source: "builtin", applies: (f) => !onlyDocs(f) },
  { id: "ui", title: "Interface", rubric: ui, source: "builtin", applies: (f) => f.some((x) => UI.test(x.path)) },
  // Claims in a description and docs left behind matter for any change, a docs-only one included.
  { id: "docs", title: "Docs and claims", rubric: docs, source: "builtin", applies: () => true, checks: true },
];

export const BUILTIN_LENS_IDS = BUILTIN.map((l) => l.id);

/** The built-in lenses as plain data, for the skills catalog. */
export function builtinLenses(): { id: string; title: string; rubric: string }[] {
  return BUILTIN.map(({ id, title, rubric }) => ({ id, title, rubric }));
}

const LENS_DIR = ".crewreview/lenses";

function titleOf(id: string, rubric: string): string {
  const h = /^#\s+(.+)$/m.exec(rubric);
  return h?.[1]?.trim() ?? id;
}

/**
 * Built-in lenses, with the repository's own versions taking over: `.crewreview/lenses/security.md` replaces the
 * built-in security rubric, and any other `<id>.md` there adds a lens. Rules are read from `rulesRef` (the base
 * branch for pull requests, so a change can't rewrite the rules it is judged by), or from the work tree.
 */
export async function loadLenses(root: string, rulesRef: string | "worktree"): Promise<Lens[]> {
  let names: string[];
  if (rulesRef === "worktree") {
    names = await readdir(join(root, LENS_DIR)).catch(() => []);
  } else {
    names = await listDir(root, rulesRef, LENS_DIR);
  }
  const repo = new Map<string, string>();
  for (const name of names) {
    const m = /^([a-z0-9][a-z0-9-]*)\.md$/.exec(name);
    if (!m) continue;
    const text =
      rulesRef === "worktree"
        ? await readFile(join(root, LENS_DIR, name), "utf8").catch(() => undefined)
        : await showFile(root, rulesRef, `${LENS_DIR}/${name}`);
    if (text && text.trim()) repo.set(m[1]!, text.slice(0, 20_000));
  }
  const out: Lens[] = BUILTIN.map((l) => {
    const r = repo.get(l.id);
    return r ? { ...l, rubric: r, title: titleOf(l.id, r), source: "repo" as const } : l;
  });
  for (const [id, rubric] of repo) {
    if (!BUILTIN_LENS_IDS.includes(id)) out.push({ id, title: titleOf(id, rubric), rubric, source: "repo", applies: () => true });
  }
  return out;
}
