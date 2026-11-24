import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitOk } from "./git.ts";

/** Folder inside the worktree for the attendant's context. Excluded from commits. */
export const ATTEND_DIR = ".crewreview-attend";

async function excludeAttendDir(mirror: string): Promise<void> {
  const file = join(mirror, "info", "exclude");
  const text = existsSync(file) ? await readFile(file, "utf8") : "";
  if (text.split("\n").includes(`/${ATTEND_DIR}/`)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${text && !text.endsWith("\n") ? "\n" : ""}/${ATTEND_DIR}/\n`);
}

/** A checkout of `sha` that belongs to Crewreview's mirror, never to your clones. */
export async function addWorktree(mirror: string, sha: string, dir: string): Promise<string> {
  await excludeAttendDir(mirror);
  await mkdir(dirname(dir), { recursive: true });
  await gitOk(["worktree", "add", "--detach", "--force", dir, sha], mirror);
  return dir;
}

export async function removeWorktree(mirror: string, dir: string): Promise<void> {
  await git(["worktree", "remove", "--force", dir], mirror);
  await rm(dir, { recursive: true, force: true });
  await git(["worktree", "prune"], mirror);
}

/** Paths changed in the worktree (tracked and new), outside the attendant's own folder. */
export async function changedPaths(dir: string): Promise<string[]> {
  const out = await gitOk(["status", "--porcelain=v1", "-z", "--untracked-files=all"], dir);
  const paths: string[] = [];
  const parts = out.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) i++; // the next part is the old name
    if (!path.startsWith(`${ATTEND_DIR}/`)) paths.push(path);
  }
  return paths;
}

/**
 * The modes of what the next commit changes against HEAD: everything gets staged first, as `commitAll` would, so a
 * new symlink or a nested repository (a submodule pointer) shows the mode it will have in the commit.
 */
export async function stagedModes(dir: string): Promise<string> {
  await gitOk(["add", "-A"], dir); // ATTEND_DIR is in info/exclude, so it never gets staged
  return gitOk(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-color", "HEAD"], dir);
}

export async function diffStat(dir: string): Promise<string> {
  await gitOk(["add", "-A"], dir); // ATTEND_DIR is in info/exclude, so it never gets staged
  return (await gitOk(["diff", "--cached", "--stat"], dir)).trim();
}

export async function stagedDiff(dir: string): Promise<string> {
  await gitOk(["add", "-A"], dir); // ATTEND_DIR is in info/exclude, so it never gets staged
  return gitOk(["diff", "--cached", "--no-color"], dir);
}

export interface CommitOptions {
  /** "inherit" uses your git config (and signs if you sign). "off" never signs (tests). */
  signing?: "inherit" | "off";
  /** Commit as someone else than your git config says. */
  identity?: { name: string; email: string };
}

/** Commit everything the attendant changed. Your git identity and signing settings apply. Returns the new sha. */
export async function commitAll(dir: string, message: string, o: CommitOptions = {}): Promise<string> {
  await gitOk(["add", "-A"], dir); // ATTEND_DIR is in info/exclude, so it never gets staged
  const config: string[] = [];
  if (o.signing === "off") config.push("-c", "commit.gpgsign=false");
  if (o.identity) config.push("-c", `user.name=${o.identity.name}`, "-c", `user.email=${o.identity.email}`);
  await gitOk([...config, "commit", "-q", "-m", message], dir);
  return (await gitOk(["rev-parse", "HEAD"], dir)).trim();
}

/** Push without force. A rejected push means the branch moved: the fix is stale. */
export async function pushHead(dir: string, branch: string, authEnv: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await git(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], dir, authEnv);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") };
}
