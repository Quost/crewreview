import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RepoRef } from "@crewreview/hosts";
import { gitOk, resolveRef } from "./git.ts";

export interface MirrorOptions {
  dataDir: string;
  repo: RepoRef;
  /** Env that carries the host token to git for this command only. */
  authEnv: Record<string, string>;
  /** An existing clone to borrow objects from on the first fetch. */
  reference?: string;
}

/** Crewreview's own bare copy of the repository. Your clones are never touched. */
export function mirrorPath(dataDir: string, repo: RepoRef): string {
  return join(dataDir, "mirrors", repo.host, `${repo.slug}.git`);
}

export async function ensureMirror(o: MirrorOptions): Promise<string> {
  const dir = mirrorPath(o.dataDir, o.repo);
  if (existsSync(join(dir, "HEAD"))) return dir;
  await mkdir(dirname(dir), { recursive: true });
  const args = ["clone", "--bare", "--no-tags"];
  if (o.reference && existsSync(o.reference)) args.push("--reference-if-able", o.reference, "--dissociate");
  args.push(o.repo.cloneUrl, dir);
  await gitOk(args, dirname(dir), o.authEnv);
  return dir;
}

export interface FetchedPull {
  mirror: string;
  headSha: string;
  baseSha: string;
}

/** Fetch the pull request head and its base branch into the mirror, under refs/crewreview/. */
export async function fetchPull(
  o: MirrorOptions & { number: number; baseRef: string; headRefspec: (local: string) => string },
): Promise<FetchedPull> {
  const mirror = await ensureMirror(o);
  const headRef = `refs/crewreview/pr/${o.number}`;
  const baseRef = `refs/crewreview/base/${o.baseRef}`;
  await gitOk(["fetch", "--no-tags", "--force", "--quiet", "origin", o.headRefspec(headRef), `+refs/heads/${o.baseRef}:${baseRef}`], mirror, o.authEnv);
  const headSha = await resolveRef(mirror, headRef);
  const baseSha = await resolveRef(mirror, baseRef);
  if (!headSha || !baseSha) throw new Error(`fetch of pull request ${o.number} left no head or base`);
  return { mirror, headSha, baseSha };
}

/** True when `a` is an ancestor of `b` (b builds on a, no force-push in between). */
export async function isAncestor(mirror: string, a: string, b: string): Promise<boolean> {
  try {
    await gitOk(["merge-base", "--is-ancestor", a, b], mirror);
    return true;
  } catch {
    return false;
  }
}
