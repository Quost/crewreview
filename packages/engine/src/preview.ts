import { reviewEligibility, type SkipReason } from "@crewreview/core";
import { countRepos, hostTransport, resolveToken } from "@crewreview/hosts";
import { connect, openInOrg, rulesFor } from "./daemon.ts";
import type { PrDeps, PrTarget } from "./pr.ts";
import { expandOrgs, isOrg, type LinkedRepo } from "./repos.ts";

/** What the crew would do with a repository or an organization right now, if its review were on. */
export interface Preview {
  link: string;
  org: boolean;
  /** Repositories looked at (an organization's with open pull requests, up to a limit). */
  repos: number;
  /** Their paths, for the dashboard to name them. */
  repoNames: string[];
  /** For an organization or group: every repository in it (subgroups included, archived left out), when the host says. */
  totalRepos?: number;
  pullRequests: number;
  wouldReview: { repo: string; number: number; title: string; url: string }[];
  skipped: Partial<Record<SkipReason, number>>;
  /** How many reviews a cycle starts; the rest wait for the next ones. */
  perCycle: number;
  /** Agent runs the reviews above would take: each lens plus the verifier. */
  agentRuns: number;
  /** Your own open pull requests: the attendant answers the reviews on these when it's on. */
  ownOpen: number;
  budget?: { used: number; limit: number };
  errors: { repo: string; error: string }[];
}

const MAX_REPOS = 30;
const MAX_CI_CALLS = 20;

/**
 * Look at a link's open pull requests the way a cycle would, without reviewing, posting or recording anything. A
 * head the crew never saw counts from its last update, so long-quiet pull requests don't look like they're settling.
 */
export async function previewLink(
  d: PrDeps,
  link: LinkedRepo,
  o: { now?: number; connectTo?: (r: LinkedRepo) => Promise<PrTarget | { error: "no-token" }>; listOrg?: (org: LinkedRepo) => Promise<string[]>; countRepos?: (org: LinkedRepo) => Promise<number | undefined> } = {},
): Promise<Preview> {
  const now = o.now ?? Date.now();
  const connectTo = o.connectTo ?? ((r: LinkedRepo) => connect(r, d.version));
  const errors: Preview["errors"] = [];
  const repos = (await expandOrgs([link], o.listOrg ?? ((org) => openInOrg(org, d.version)), (org, e) => errors.push({ repo: org.id, error: e instanceof Error ? e.message : String(e) }))).slice(0, MAX_REPOS);
  const totalRepos = isOrg(link) ? await (o.countRepos ?? ((org: LinkedRepo) => countOrgRepos(org, d.version)))(link).catch(() => undefined) : undefined;
  const p: Preview = { link: link.id, org: isOrg(link), repos: repos.length, repoNames: repos.map((r) => r.ref.slug), totalRepos, pullRequests: 0, wouldReview: [], skipped: {}, perCycle: d.config.schedule.maxReviewsPerCycle, agentRuns: 0, ownOpen: 0, errors };
  const users = new Map<string, string>();
  let ciCalls = 0;
  for (const repo of repos) {
    const target = await connectTo(repo);
    if ("error" in target) {
      errors.push({ repo: repo.id, error: "no-token" });
      continue;
    }
    try {
      if (!users.has(repo.ref.host)) users.set(repo.ref.host, await target.host.whoami());
      const me = users.get(repo.ref.host)!;
      const rules = { ...rulesFor(repo, d.config), authors: link.review.authors };
      const runsPerReview = (repo.review.lenses ?? d.config.review.lenses).length + 1;
      for (const pr of await target.host.listOpenPullRequests()) {
        p.pullRequests++;
        if (pr.author.toLowerCase() === me.toLowerCase() && !pr.draft) p.ownOpen++;
        const input = {
          pr,
          me,
          rules,
          reviewedSha: d.store.lastDone(repo.id, pr.number)?.headSha,
          failuresOnHead: d.store.failures(repo.id, pr.number, pr.headSha),
          firstSeenAt: d.store.seenAt(repo.id, pr.number, pr.headSha) ?? (Date.parse(pr.updatedAt) || now),
          now,
          ci: undefined,
        };
        let e = reviewEligibility(input);
        if (e.eligible && rules.ciMaxWaitMs > 0 && ciCalls < MAX_CI_CALLS) {
          ciCalls++;
          e = reviewEligibility({ ...input, ci: (await target.host.getChecks(pr)).state });
        }
        if (e.eligible) {
          p.wouldReview.push({ repo: repo.ref.slug, number: pr.number, title: pr.title, url: pr.url });
          p.agentRuns += runsPerReview;
        } else {
          p.skipped[e.reason] = (p.skipped[e.reason] ?? 0) + 1;
        }
      }
    } catch (e) {
      errors.push({ repo: repo.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const limit = d.config.limits.dailyRuns;
  if (limit) p.budget = { used: d.quota?.runsToday() ?? 0, limit };
  return p;
}

/** Every repository of an organization link, counted with a token found on this machine. */
async function countOrgRepos(org: LinkedRepo, version: string): Promise<number | undefined> {
  const tk = await resolveToken(org.ref);
  return tk ? countRepos(org.ref, hostTransport(org.ref, tk.token, `crewreview/${version}`)) : undefined;
}
