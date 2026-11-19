import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseUnifiedDiff, redactSecrets, totalChangedLines, type DiffFile, type FileOracle } from "@crewreview/core";
import { commitSubjects, diffText, exportTree, fileHistory, mergeBase, showFile } from "./git.ts";

/** Project docs that hold rules a reviewer should apply, read from the rules ref. */
const GUIDELINE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/copilot-instructions.md", ".cursorrules", "docs/CONTRIBUTING.md"];
const GUIDELINE_MAX = 20_000;

export interface ChangeContext {
  jobDir: string;
  headDir: string;
  ctxDir: string;
  branch: string;
  base: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  files: DiffFile[];
  changedLines: number;
  commits: string[];
  guidelines: string[];
}

export interface BuildContextOptions {
  root: string;
  jobDir: string;
  branch: string;
  base: string;
  baseSha: string;
  headSha: string;
  /** Where project rules come from: the base for pull requests, the head (your own work) for local reviews. */
  rulesRef: string;
  /** More files for ./ctx/ (pull request text, discussion, CI, delta since the last review). */
  extraContext?: Record<string, string>;
}

/** Lay out the job folder the agents work in: `head/` (the tree) and `ctx/` (everything else). */
export async function buildContext(o: BuildContextOptions): Promise<ChangeContext> {
  const headDir = join(o.jobDir, "head");
  const ctxDir = join(o.jobDir, "ctx");
  await mkdir(ctxDir, { recursive: true });

  const mb = await mergeBase(o.root, o.baseSha, o.headSha);
  const diff = await diffText(o.root, mb, o.headSha);
  const files = parseUnifiedDiff(diff);
  const commits = await commitSubjects(o.root, mb, o.headSha);

  await exportTree(o.root, o.headSha, headDir);
  await writeFile(join(ctxDir, "diff.patch"), diff);
  await writeFile(
    join(ctxDir, "files.txt"),
    files.map((f) => `${f.status.padEnd(8)} +${f.additions} -${f.deletions}  ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`).join("\n") + "\n",
  );
  await writeFile(
    join(ctxDir, "change.md"),
    [
      `# Change`,
      ``,
      `- Branch: ${o.branch}`,
      `- Base: ${o.base} (${o.baseSha.slice(0, 12)}), merge base ${mb.slice(0, 12)}`,
      `- Head: ${o.headSha.slice(0, 12)}`,
      ``,
      `## Commits`,
      ...(commits.length ? commits.map((c) => `- ${redactSecrets(c)}`) : ["- (no commits: uncommitted changes)"]),
      ``,
    ].join("\n"),
  );

  const guidelines: string[] = [];
  const parts: string[] = [];
  for (const path of GUIDELINE_FILES) {
    const text = await showFile(o.root, o.rulesRef, path);
    if (!text?.trim()) continue;
    guidelines.push(path);
    const clipped = text.length > GUIDELINE_MAX ? `${text.slice(0, GUIDELINE_MAX)}\n\n[… cut at ${GUIDELINE_MAX} characters]` : text;
    parts.push(`<!-- ${path} -->\n${clipped.trim()}\n`);
  }
  await writeFile(join(ctxDir, "guidelines.md"), parts.length ? parts.join("\n") : "(The project has no written guidelines.)\n");

  const history: string[] = ["# Recent history of the changed files", ""];
  for (const f of files.slice(0, 25)) {
    if (f.status === "added") continue;
    const log = await fileHistory(o.root, mb, f.oldPath ?? f.path);
    if (log.length) history.push(`## ${f.path}`, ...log.map((l) => `- ${redactSecrets(l)}`), "");
  }
  await writeFile(join(ctxDir, "history.md"), history.join("\n"));
  for (const [name, content] of Object.entries(o.extraContext ?? {})) {
    if (!/^[a-z0-9-]+\.(md|patch|txt|json)$/.test(name)) throw new Error(`bad context file name: ${name}`);
    await writeFile(join(ctxDir, name), content);
  }

  return {
    jobDir: o.jobDir,
    headDir,
    ctxDir,
    branch: o.branch,
    base: o.base,
    baseSha: o.baseSha,
    headSha: o.headSha,
    mergeBaseSha: mb,
    files,
    changedLines: totalChangedLines(files),
    commits,
    guidelines,
  };
}

/** Answers line counts from the exported tree, refusing anything outside it. */
export function treeOracle(headDir: string): FileOracle {
  const cache = new Map<string, number | null>();
  return {
    lineCount(path) {
      if (cache.has(path)) return cache.get(path)!;
      let n: number | null = null;
      try {
        const full = join(headDir, path);
        if (!full.startsWith(headDir)) return null;
        if (statSync(full).isFile()) {
          const text = readFileSync(full, "utf8");
          n = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        }
      } catch {
        n = null;
      }
      cache.set(path, n);
      return n;
    },
  };
}
