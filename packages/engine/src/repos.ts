import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_RULES, REVIEW_PROFILES, SEVERITIES } from "@crewreview/core";
import { globMatch, parseOwnerUrl, parseRepoUrl, repoRef, type RepoRef } from "@crewreview/hosts";
import { z } from "zod";
import { ConfigError, parseDuration } from "./config.ts";
import type { AppDirs } from "./paths.ts";

export const REVIEW_MODES = ["off", "inbox", "auto"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

const ReviewSettings = z
  .object({
    /** off: nothing. inbox: review and wait for your approval. auto: review and post. */
    mode: z.enum(REVIEW_MODES).default("inbox"),
    authors: z.enum(["others", "all", "mine"]).default(DEFAULT_RULES.authors),
    baseBranches: z.array(z.string()).default([]),
    skipLabels: z.array(z.string()).default(DEFAULT_RULES.skipLabels),
    reviewDrafts: z.boolean().default(false),
    reviewBots: z.boolean().default(false),
    lenses: z.array(z.string()).optional(),
    commentLanguage: z.string().optional(),
    harness: z.string().optional(),
    verifier: z.string().optional(),
    allowApprove: z.boolean().optional(),
    /** fast, standard or gate: over the global review.profile. */
    profile: z.enum(REVIEW_PROFILES).optional(),
    /** From which severity a review requests changes, or "never": over review.policy.requestChangesAt. */
    requestChangesAt: z.union([z.enum(SEVERITIES), z.literal("never")]).optional(),
    /** Approve only a trusted review: over review.policy.requireTrusted (the gate profile turns it on). */
    requireTrusted: z.boolean().optional(),
    /** Above this many changed lines, no automatic approval: over review.policy.approveMaxChangedLines. */
    approveMaxChangedLines: z.number().int().min(0).optional(),
    /** crewreview (🔴 🟠 🟡 ⚪) or tupi (⛔ ⚠ 💅). */
    severityStyle: z.enum(["crewreview", "tupi"]).optional(),
    /** At most this many nits inline; the rest listed in the summary. */
    maxNits: z.number().int().min(0).optional(),
    /** More project rules for the reviewers, besides AGENTS.md and the like: paths in the repository; a folder gives its .md files. */
    guidelines: z.array(z.string()).optional(),
    /** Post reviews as this account instead of yours: a login signed in to gh, or env:VARIABLE with its token. */
    account: z.string().optional(),
  })
  .strict();

const AttendSettings = z
  .object({
    /** off: nothing. inbox: fix and draft replies, wait for your approval. auto: push and reply. */
    mode: z.enum(REVIEW_MODES).default("off"),
    /** false: only answer, never change code. */
    fix: z.boolean().default(true),
    /** The polish loop: also act on findings Crewreview's reviewer left on your pull request. */
    fromCrew: z.boolean().default(false),
    /** How many published polish rounds per pull request before the loop stops. */
    maxPolishRounds: z.number().int().min(0).default(3),
    /** Bots whose comments count (substring of the login). */
    trustedBots: z.array(z.string()).default(["copilot"]),
    /**
     * Also fix a conflict with the base: merge it (never rebase) and resolve the conflict markers. In a stack, also
     * take in the pull request below whenever it moves, and the base once it's merged.
     */
    conflicts: z.boolean().default(false),
    /** Also fix what turned CI red on your pull request, from the failing jobs' logs. */
    ci: z.boolean().default(false),
    /**
     * Protected files (CI, deployment, AGENTS.md…) a reviewer commented on may be changed to answer that comment.
     * approve: that change waits for you, even in auto mode. auto: it goes out like any fix. Secrets never change.
     */
    protectedFiles: z.enum(["approve", "auto"]).default("approve"),
    /** Commands that must pass in the worktree before anything is pushed, e.g. ["bun test"]. */
    validate: z.array(z.string()).default([]),
    harness: z.string().optional(),
    resolve: z.boolean().default(true),
    reReview: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).default(3),
    commentLanguage: z.string().optional(),
  })
  .strict();

const RepoEntry = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    url: z.string(),
    kind: z.enum(["github", "gitlab"]).optional(),
    /** An existing clone on this machine: the mirror borrows its objects so the first fetch is fast. */
    clone: z.string().optional(),
    /**
     * `org`: the URL is a GitHub organization or user, or a GitLab group, and every repository in it is linked with
     * these settings: new ones too, archived ones never. A repository linked on its own keeps its own settings.
     */
    scope: z.enum(["repo", "org"]).optional(),
    /** For an organization: only repositories whose path in it matches one of these (`*`, `**`, `?`). */
    include: z.array(z.string()).optional(),
    /** For an organization: leave out repositories whose path in it matches one of these. */
    exclude: z.array(z.string()).optional(),
    /** Linked but left alone: no reviews, no answers, until it's resumed. For an organization, all of it. */
    paused: z.boolean().optional(),
    review: ReviewSettings.prefault({}),
    attend: AttendSettings.prefault({}),
  })
  .strict();

const ReposFile = z.object({ repo: z.array(RepoEntry).default([]) }).strict();

export type RepoEntry = z.output<typeof RepoEntry>;
export type ReviewSettings = z.output<typeof ReviewSettings>;
export type AttendSettings = z.output<typeof AttendSettings>;

export interface LinkedRepo extends RepoEntry {
  ref: RepoRef;
  /** The organization link this repository comes from, when it isn't linked on its own. */
  org?: string;
}

export const isOrg = (r: Pick<RepoEntry, "scope">): boolean => r.scope === "org";

export function reposFile(dirs: AppDirs): string {
  return join(dirs.config, "repos.toml");
}

/** A short id from the slug: "acme/shop" → "acme-shop". */
export function repoIdFor(ref: RepoRef): string {
  return ref.slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function loadRepos(path: string): Promise<LinkedRepo[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ConfigError(path, (e as Error).message);
  }
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError(path, (e as Error).message);
  }
  const r = ReposFile.safeParse(raw);
  if (!r.success) throw new ConfigError(path, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const ids = new Set<string>();
  return r.data.repo.map((e) => {
    if (ids.has(e.id)) throw new ConfigError(path, `two repositories share the id "${e.id}"`);
    ids.add(e.id);
    try {
      return { ...e, ref: e.scope === "org" ? parseOwnerUrl(e.url, e.kind) : parseRepoUrl(e.url, e.kind) };
    } catch (err) {
      throw new ConfigError(path, `${e.id}: ${(err as Error).message}`);
    }
  });
}

function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  throw new Error(`can't write ${typeof v} to TOML`);
}

/** The file is Crewreview's to write (the CLI and the dashboard both change it); edit it by hand if you like. */
export function serializeRepos(repos: readonly RepoEntry[]): string {
  const out = ["# Repositories linked to Crewreview. `crewreview repo add` and the dashboard write this file.", ""];
  for (const r of repos) {
    out.push("[[repo]]");
    for (const k of ["id", "url", "kind", "clone", "scope", "include", "exclude", "paused"] as const) if (r[k] !== undefined) out.push(`${k} = ${tomlValue(r[k])}`);
    out.push("", "[repo.review]");
    for (const [k, v] of Object.entries(r.review)) if (v !== undefined) out.push(`${k} = ${tomlValue(v)}`);
    out.push("", "[repo.attend]");
    for (const [k, v] of Object.entries(r.attend)) if (v !== undefined) out.push(`${k} = ${tomlValue(v)}`);
    out.push("");
  }
  return out.join("\n");
}

export async function saveRepos(path: string, repos: readonly RepoEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, serializeRepos(repos));
  await rename(tmp, path);
}

export function newRepoEntry(
  ref: RepoRef,
  overrides: Omit<Partial<RepoEntry>, "review" | "attend"> & { review?: Partial<ReviewSettings>; attend?: Partial<AttendSettings> } = {},
): RepoEntry {
  const review = ReviewSettings.parse(overrides.review ?? {});
  const attend = AttendSettings.parse(overrides.attend ?? {});
  return RepoEntry.parse({
    id: overrides.id ?? repoIdFor(ref),
    url: ref.webUrl,
    kind: ref.kind,
    clone: overrides.clone,
    scope: overrides.scope === "org" ? "org" : undefined,
    include: overrides.include?.length ? overrides.include : undefined,
    exclude: overrides.exclude?.length ? overrides.exclude : undefined,
    paused: overrides.paused || undefined,
    review,
    attend,
  });
}

/** Whether a repository at `path` in an organization link passes its include and exclude filters. */
export function inOrg(org: Pick<RepoEntry, "include" | "exclude">, path: string): boolean {
  if (org.include?.length && !org.include.some((p) => globMatch(p, path))) return false;
  return !org.exclude?.some((p) => globMatch(p, path));
}

/** One repository of an organization link, with the organization's settings. */
export function orgMember(org: LinkedRepo, slug: string): LinkedRepo {
  const ref = repoRef(org.ref.kind, org.ref.host, slug);
  const { scope: _s, include: _i, exclude: _e, clone: _c, ...settings } = org;
  return { ...settings, id: repoIdFor(ref), url: ref.webUrl, ref, org: org.id };
}

/**
 * Replace each organization link with its repositories that have something to do now, as `list` reports them.
 * Repositories linked on their own win over their organization's settings. Organizations that can't be listed are
 * reported to `onError` and skipped this time.
 */
export async function expandOrgs(
  links: readonly LinkedRepo[],
  list: (org: LinkedRepo) => Promise<string[]>,
  onError: (org: LinkedRepo, error: unknown) => void = () => {},
): Promise<LinkedRepo[]> {
  const own = links.filter((r) => !isOrg(r));
  const taken = new Set(own.flatMap((r) => [r.id, r.ref.webUrl.toLowerCase()]));
  const out = [...own];
  for (const org of links.filter(isOrg)) {
    let slugs: string[];
    try {
      slugs = await list(org);
    } catch (e) {
      onError(org, e);
      continue;
    }
    for (const slug of slugs) {
      if (!slug.toLowerCase().startsWith(`${org.ref.slug.toLowerCase()}/`) || !inOrg(org, slug.slice(org.ref.slug.length + 1))) continue;
      const member = orgMember(org, slug);
      if (taken.has(member.id) || taken.has(member.ref.webUrl.toLowerCase())) continue;
      taken.add(member.id);
      out.push(member);
    }
  }
  return out;
}

/**
 * The linked repository an inbox item or job belongs to: linked on its own, or one of an organization's, found by
 * the pull request's address.
 */
export function findLinked(links: readonly LinkedRepo[], id: string, prUrl?: string): LinkedRepo | undefined {
  const own = links.find((r) => r.id === id && !isOrg(r));
  if (own || !prUrl) return own;
  let ref: RepoRef;
  try {
    ref = parseRepoUrl(prUrl);
  } catch {
    return undefined;
  }
  for (const org of links.filter(isOrg)) {
    if (org.ref.host !== ref.host || !ref.slug.toLowerCase().startsWith(`${org.ref.slug.toLowerCase()}/`)) continue;
    const member = orgMember(org, ref.slug);
    if (member.id === id) return member;
  }
  return undefined;
}

export { parseDuration };
