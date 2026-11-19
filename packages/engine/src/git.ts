import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

/** Run git without a pager, colors, external diff tools or prompts. */
export async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-c", "core.pager=cat", "-c", "color.ui=false", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", LC_ALL: "C", ...env } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export async function gitOk(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const r = await git(args, cwd, env);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout;
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function resolveRef(root: string, ref: string): Promise<string | undefined> {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function currentBranch(root: string): Promise<string> {
  const r = await git(["symbolic-ref", "--short", "-q", "HEAD"], root);
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return (await gitOk(["rev-parse", "--short", "HEAD"], root)).trim();
}

/** The branch this one will merge into: origin's default, then the usual names. */
export async function detectBase(root: string): Promise<string | undefined> {
  const head = await git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], root);
  const candidates: string[] = [];
  if (head.code === 0 && head.stdout.trim()) candidates.push(head.stdout.trim().replace(/^refs\/remotes\//, ""));
  candidates.push("origin/main", "origin/master", "origin/develop", "main", "master", "develop");
  const branch = await currentBranch(root);
  for (const c of candidates) {
    if (c === branch || c === `origin/${branch}`) continue;
    if (await resolveRef(root, c)) return c;
  }
  return undefined;
}

export async function mergeBase(root: string, a: string, b: string): Promise<string> {
  return (await gitOk(["merge-base", a, b], root)).trim();
}

export async function diffText(root: string, from: string, to: string): Promise<string> {
  return gitOk(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3", from, to], root);
}

/** Snapshot of uncommitted changes to tracked files as a commit object, without touching the index or the work tree. */
export async function stashCreate(root: string): Promise<string | undefined> {
  const sha = (await gitOk(["stash", "create"], root)).trim();
  return sha || undefined;
}

export async function commitSubjects(root: string, from: string, to: string, max = 50): Promise<string[]> {
  const out = await gitOk(["log", "--no-merges", `--max-count=${max}`, "--format=%h %s", `${from}..${to}`], root);
  return out.split("\n").filter(Boolean);
}

export async function showFile(root: string, ref: string, path: string): Promise<string | undefined> {
  const r = await git(["show", `${ref}:${path}`], root);
  return r.code === 0 ? r.stdout : undefined;
}

export async function listDir(root: string, ref: string, dir: string): Promise<string[]> {
  const r = await git(["ls-tree", "--name-only", `${ref}:${dir}`], root);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export async function fileHistory(root: string, ref: string, path: string, max = 5): Promise<string[]> {
  const r = await git(["log", `--max-count=${max}`, "--format=%h %ad %s", "--date=short", ref, "--", path], root);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/**
 * Write the tree of `commit` into `dest` using a throwaway index, so the user's index, HEAD and worktree list
 * stay untouched. Submodules are skipped and LFS files stay as pointers.
 */
export async function exportTree(root: string, commit: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const tmp = await mkdtemp(join(tmpdir(), "crewreview-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    await gitOk(["read-tree", commit], root, env);
    await gitOk([`--work-tree=${dest}`, "checkout-index", "--all", "--force"], root, env);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
