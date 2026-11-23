import { lstatSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changedSymbols, fitGuidelines, normalizeRepoPath, parseUnifiedDiff, redactSecrets, slimDiff, totalChangedLines, type DiffFile, type FileOracle, type GuidelineDoc, type OmittedFile } from "@crewreview/core";
import { commitSubjects, diffText, exportTree, fileHistory, grepWord, listDir, mergeBase, showFile } from "./git.ts";

/** Project docs that hold rules a reviewer should apply, read from the rules ref. */
const GUIDELINE_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/copilot-instructions.md", ".cursorrules", "docs/CONTRIBUTING.md"];
/** Folders of rules agents follow in that project (Kiro steering, Copilot instructions): their .md files. */
const GUIDELINE_DIRS = [".kiro/steering", ".github/instructions"];

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
  /** Changed files whose diff the agents don't get: minified, generated or too large to read. */
  omitted: OmittedFile[];
  changedLines: number;
  commits: string[];
  guidelines: string[];
  /** Rules read only in part. */
  guidelinesCut: string[];
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
  /** More rules the repository's settings name: paths in it; a folder gives its .md files. */
  guidelines?: readonly string[];
}

/** The project's rules from the rules ref: the usual files, then the ones the settings name, then rule folders. */
async function readGuidelines(root: string, ref: string, extra: readonly string[]): Promise<GuidelineDoc[]> {
  const docs: GuidelineDoc[] = [];
  const seen = new Set<string>();
  const add = async (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = await showFile(root, ref, path);
    if (text?.trim()) docs.push({ path, text });
  };
  const folder = async (dir: string) => {
    for (const name of (await listDir(root, ref, dir)).filter((n) => n.toLowerCase().endsWith(".md")).sort()) await add(`${dir}/${name}`);
  };
  for (const path of GUIDELINE_FILES) await add(path);
  for (const raw of extra) {
    const path = normalizeRepoPath(raw);
    if (!path) continue;
    if ((await listDir(root, ref, path)).length) await folder(path);
    else await add(path);
  }
  for (const dir of GUIDELINE_DIRS) await folder(dir);
  return docs;
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

  const slim = slimDiff(diff);
  const left = new Map(slim.omitted.map((f) => [f.path, f]));

  await exportTree(o.root, o.headSha, headDir);
  await writeFile(join(ctxDir, "diff.patch"), slim.text);
  await writeFile(
    join(ctxDir, "files.txt"),
    files
      .map((f) => {
        const out = left.get(f.path);
        const note = out ? (out.reason === "minified" ? "  (diff left out: minified or generated)" : "  (diff cut: too large; the rest is in ./head/, see the note in diff.patch)") : "";
        return `${f.status.padEnd(8)} +${f.additions} -${f.deletions}  ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}${note}`;
      })
      .join("\n") + "\n",
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

  const fit = fitGuidelines(await readGuidelines(o.root, o.rulesRef, o.guidelines ?? []));
  const guidelines = fit.included.map((d) => d.path);
  const parts = fit.included.map((d) => `<!-- ${d.path} -->\n${d.text}\n`);
  if (fit.cut.length) parts.unshift(`(Read only in part, too long for the room: ${fit.cut.join(", ")}.)\n`);
  await writeFile(join(ctxDir, "guidelines.md"), parts.length ? parts.join("\n") : "(The project has no written guidelines.)\n");

  const history: string[] = ["# Recent history of the changed files", ""];
  for (const f of files.slice(0, 25)) {
    if (f.status === "added") continue;
    const log = await fileHistory(o.root, mb, f.oldPath ?? f.path);
    if (log.length) history.push(`## ${f.path}`, ...log.map((l) => `- ${redactSecrets(l)}`), "");
  }
  await writeFile(join(ctxDir, "history.md"), history.join("\n"));
  await writeFile(join(ctxDir, "callers.md"), await callersMarkdown(o.root, o.headSha, diff));
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
    omitted: slim.omitted,
    changedLines: totalChangedLines(files),
    commits,
    guidelines,
    guidelinesCut: fit.cut,
  };
}

const CALLERS_PER_NAME = 25;

/**
 * For each function the change defines or modifies, where else its name appears at the reviewed commit: the callers
 * a changed contract can break, which usually aren't in the diff. Found by git here, so the agents only have to judge
 * them, not remember to look.
 */
async function callersMarkdown(root: string, headSha: string, diff: string): Promise<string> {
  const out = ["# Where the changed functions are used", "", "For each function this change defines, modifies or removes: every other line in ./head/ that names it (a whole-word match, so some may be unrelated). A caller here that wasn't changed still has to handle what the function does now.", ""];
  const symbols = changedSymbols(diff);
  if (symbols.length === 0) return `${out.join("\n")}(No function definitions found in the change.)\n`;
  for (const s of symbols) {
    const { hits, more } = await grepWord(root, headSha, s.name, CALLERS_PER_NAME + 10);
    // The definition itself isn't a use.
    const uses = hits.filter((h) => !(h.path === s.path && new RegExp(`\\b(def|defp|function|func|fn|fun)\\s+${s.name.replace(/[$?!]/g, "\\$&")}\\b`).test(h.text)));
    out.push(`## ${s.name} (defined in ${s.path})`);
    if (uses.length === 0) out.push("- no other uses found");
    for (const h of uses.slice(0, CALLERS_PER_NAME)) out.push(`- ${h.path}:${h.line}: ${redactSecrets(h.text.trim()).slice(0, 200)}`);
    if (more || uses.length > CALLERS_PER_NAME) out.push(`- … more uses not listed: search ./head/ for "${s.name}"`);
    out.push("");
  }
  return out.join("\n");
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
        // A link is never followed: git stores it as a one-line blob (its target), and that is what the change
        // shows. Following it would read outside the tree, or call a link the change adds "missing" when it dangles.
        const st = lstatSync(full);
        if (st.isSymbolicLink()) n = 1;
        else if (st.isFile()) {
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
