import type { AttendItem } from "./attend.ts";

/** What a stack needs to know about an open pull request. */
export interface StackPr {
  number: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  fromFork: boolean;
}

/**
 * The open pull request each one sits on: the one whose branch is its base. A fork's branch lives in another
 * repository, so forks never stack, either way.
 */
export function stackParents<T extends StackPr>(prs: readonly T[]): Map<number, T> {
  const byHead = new Map<string, T>();
  for (const p of prs) if (!p.fromFork && !byHead.has(p.headRef)) byHead.set(p.headRef, p);
  const out = new Map<number, T>();
  for (const p of prs) {
    if (p.fromFork) continue;
    const parent = byHead.get(p.baseRef);
    if (parent && parent.number !== p.number) out.set(p.number, parent);
  }
  return out;
}

/**
 * The pull requests in an order where each comes after the one it sits on, so a change at the bottom of a stack
 * reaches the top in one pass. Otherwise the order given is kept; a loop (A on B on A) is cut where it closes.
 */
export function stackOrder<T extends StackPr>(prs: readonly T[]): T[] {
  const parents = stackParents(prs);
  const out: T[] = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();
  const place = (p: T) => {
    if (placed.has(p.number) || visiting.has(p.number)) return;
    visiting.add(p.number);
    const parent = parents.get(p.number);
    if (parent) place(parent);
    visiting.delete(p.number);
    placed.add(p.number);
    out.push(p);
  };
  for (const p of prs) place(p);
  return out;
}

/** A pull request's link to the one below it, as last seen while both were open. */
export interface StackLink {
  parent: number;
  /** The branch of the pull request below, which was this one's base. */
  parentRef: string;
  /** Its newest head we saw. */
  parentSha: string;
}

export interface SyncInput {
  /** The pull request's base branch now. */
  baseRef: string;
  /** The open pull request it sits on, if any. */
  parent?: { number: number };
  /** The link remembered from before, if any. */
  link?: StackLink;
  /** The base's newest commit isn't in the branch yet. */
  behind: boolean;
  /** The link's last parent head is in the branch (the branch was built on it). */
  linkInHead: boolean;
}

export type SyncPlan =
  | { kind: "none" }
  /**
   * Merge the base into the branch. `stacked`: the pull request below moved. `restack`: the one below was merged
   * (often squashed) and this one now targets its base; the merge then compares from `mergeBase`, the last head
   * of the one below, so the commits it shared with that pull request don't conflict with their own squash.
   */
  | { kind: "merge"; why: "stacked" | "restack"; parent: number; mergeBase?: string };

/** Whether a branch in a stack needs its base merged in, and how. Pure: git answers `behind` and `linkInHead`. */
export function syncPlan(i: SyncInput): SyncPlan {
  if (!i.behind) return { kind: "none" };
  if (i.parent) return { kind: "merge", why: "stacked", parent: i.parent.number };
  if (i.link && i.link.parentRef !== i.baseRef && i.linkInHead) return { kind: "merge", why: "restack", parent: i.link.parent, mergeBase: i.link.parentSha };
  return { kind: "none" };
}

/**
 * Whether the remembered link has done its job: the branch moved off the pull request below and either took its
 * base in already or wasn't built on its last head. Keeping it longer would compare later merges from too far back.
 */
export function linkSpent(i: SyncInput): boolean {
  return !!i.link && i.link.parentRef !== i.baseRef && (!i.behind || !i.linkInHead);
}

/**
 * The item that merges the base into a stacked branch. Its key names both commits: a new push on either side is a
 * new try, and one left to you doesn't come back for the same pair.
 */
export function syncItem(plan: Extract<SyncPlan, { kind: "merge" }>, s: { headSha: string; baseSha: string; baseRef: string }, done: ReadonlySet<string>): AttendItem | undefined {
  const key = `sync:${s.headSha}:${s.baseSha}`;
  if (done.has(key)) return undefined;
  const text =
    plan.why === "stacked"
      ? `This branch sits on #${plan.parent} (${s.baseRef}), which moved. ${s.baseRef} has been merged into the working copy so the stack stays in line. If any file has conflict markers, resolve them keeping what both sides meant: this branch builds on ${s.baseRef}, so keep its own changes on top of what came from there.`
      : `#${plan.parent}, the pull request this branch sat on, has been merged, and this branch now targets ${s.baseRef}. ${s.baseRef} has been merged into the working copy, compared from #${plan.parent}'s last head so the commits both shared don't conflict with their squash. If any file still has conflict markers, resolve them keeping this branch's own changes on top of ${s.baseRef}.`;
  return { key, kind: "conflict", author: "", text, createdAt: "", fromCrew: false };
}
