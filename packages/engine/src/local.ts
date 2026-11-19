import { currentBranch, detectBase, repoRoot, resolveRef, stashCreate } from "./git.ts";
import type { ReviewTarget } from "./review.ts";

export class LocalTargetError extends Error {
  constructor(
    readonly code: "not-git-repo" | "no-base" | "bad-ref",
    readonly details: Record<string, string> = {},
  ) {
    super(code);
  }
}

export interface LocalTargetOptions {
  cwd: string;
  base?: string;
  /** Include uncommitted changes to tracked files. */
  uncommitted?: boolean;
}

/** What `crewreview local` reviews: HEAD (plus, optionally, uncommitted work) against the base branch. */
export async function localTarget(o: LocalTargetOptions): Promise<ReviewTarget> {
  const root = await repoRoot(o.cwd);
  if (!root) throw new LocalTargetError("not-git-repo", { path: o.cwd });
  const base = o.base ?? (await detectBase(root));
  if (!base) throw new LocalTargetError("no-base");
  const baseSha = await resolveRef(root, base);
  if (!baseSha) throw new LocalTargetError("bad-ref", { ref: base });
  const head = await resolveRef(root, "HEAD");
  if (!head) throw new LocalTargetError("bad-ref", { ref: "HEAD" });
  const headSha = (o.uncommitted ? await stashCreate(root) : undefined) ?? head;
  return {
    root,
    branch: await currentBranch(root),
    base,
    baseSha,
    headSha,
    // Your own branch: its rules are yours, so they come from the reviewed commit itself.
    rulesRef: headSha,
    ci: "none",
  };
}
