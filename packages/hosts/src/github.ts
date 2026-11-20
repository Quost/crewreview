import type { CiState, PullRequest, VerdictEvent } from "@crewreview/core";
import { HostError, paginate, type HttpResponse, type Transport } from "./transport.ts";
import type { Checks, HostAdapter, Permission, PostResult, RepoRef, Review, Thread } from "./types.ts";

function nextLink(res: HttpResponse): { path: string } | undefined {
  const link = res.headers.get("link");
  const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
  return m ? { path: m[1]! } : undefined;
}

function mapPull(p: any): PullRequest {
  return {
    number: p.number,
    title: p.title ?? "",
    body: p.body ?? "",
    author: p.user?.login ?? "",
    authorIsBot: p.user?.type === "Bot" || /\[bot\]$/.test(p.user?.login ?? ""),
    draft: Boolean(p.draft),
    state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed",
    headSha: p.head?.sha ?? "",
    headRef: p.head?.ref ?? "",
    baseRef: p.base?.ref ?? "",
    baseSha: p.base?.sha,
    labels: (p.labels ?? []).map((l: any) => l.name),
    updatedAt: p.updated_at ?? "",
    url: p.html_url ?? "",
    fromFork: Boolean(p.head?.repo && p.base?.repo && p.head.repo.full_name !== p.base.repo.full_name),
    // Only the single pull request carries these; GitHub may still be working it out (null).
    conflicts: p.mergeable_state === "dirty" || p.mergeable === false ? true : p.mergeable === true ? false : undefined,
  };
}

const THREADS = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line originalLine comments(first:100){nodes{databaseId body createdAt author{login __typename}}}}}}}}`;

const EVENT: Record<VerdictEvent, string> = { approve: "APPROVE", comment: "COMMENT", request_changes: "REQUEST_CHANGES" };

/** Map check runs and legacy commit statuses to one CI state. */
export function githubCiState(runs: any[], statuses: any[]): Checks {
  const failing: Checks["failing"] = [];
  let running = false;
  let any = false;
  for (const r of runs) {
    any = true;
    if (r.status !== "completed") running = true;
    else if (["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(r.conclusion)) {
      // A GitHub Actions check run has the id of its job, whose log can be read.
      failing.push({ name: r.name, url: r.html_url, allowedToFail: false, ...(r.app?.slug === "github-actions" && r.id ? { job: String(r.id) } : {}) });
    }
  }
  for (const s of statuses) {
    any = true;
    if (s.state === "pending") running = true;
    else if (s.state === "failure" || s.state === "error") failing.push({ name: s.context, url: s.target_url, allowedToFail: false });
  }
  const state: CiState = !any ? "none" : failing.length ? "red" : running ? "running" : "green";
  return { state, failing };
}

export function githubHost(repo: RepoRef, t: Transport): HostAdapter {
  const [owner, name] = repo.slug.split("/") as [string, string];
  const base = `/repos/${repo.slug}`;
  const graphqlUrl = repo.apiBase === "https://api.github.com" ? "https://api.github.com/graphql" : repo.apiBase.replace(/\/api\/v3$/, "/api/graphql");
  let me: string | undefined;

  const self: HostAdapter = {
    repo,

    async whoami() {
      me ??= (await t.request("GET", "/user")).data.login as string;
      return me;
    },

    async listOpenPullRequests() {
      const list = await paginate<any>(t, `${base}/pulls`, { state: "open", per_page: 100 }, nextLink, 500);
      return list.map(mapPull);
    },

    async getPullRequest(number) {
      return mapPull((await t.request("GET", `${base}/pulls/${number}`)).data);
    },

    async listThreads(number) {
      const threads: Thread[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res = await t.request("POST", graphqlUrl, { body: { query: THREADS, variables: { owner, name, number, after } } });
        if (res.data?.errors?.length) throw new HostError("invalid", 200, res.data.errors[0].message);
        const rt = res.data?.data?.repository?.pullRequest?.reviewThreads;
        if (!rt) break;
        for (const n of rt.nodes) {
          threads.push({
            id: n.id,
            path: n.path ?? undefined,
            line: n.line ?? n.originalLine ?? undefined,
            resolvable: true,
            resolved: Boolean(n.isResolved),
            outdated: Boolean(n.isOutdated),
            comments: n.comments.nodes.map((c: any) => ({
              id: String(c.databaseId),
              author: c.author?.login ?? "ghost",
              authorIsBot: c.author?.__typename === "Bot",
              body: c.body ?? "",
              createdAt: c.createdAt,
            })),
          });
        }
        if (!rt.pageInfo.hasNextPage) break;
        after = rt.pageInfo.endCursor;
      }
      const conversation = await paginate<any>(t, `/repos/${repo.slug}/issues/${number}/comments`, { per_page: 100 }, nextLink, 500);
      for (const c of conversation) {
        threads.push({
          id: `issue-comment-${c.id}`,
          resolvable: false,
          resolved: false,
          outdated: false,
          comments: [{ id: String(c.id), author: c.user?.login ?? "ghost", authorIsBot: c.user?.type === "Bot", body: c.body ?? "", createdAt: c.created_at }],
        });
      }
      return threads;
    },

    async listReviews(number) {
      const list = await paginate<any>(t, `${base}/pulls/${number}/reviews`, { per_page: 100 }, nextLink, 500);
      const states: Record<string, Review["state"]> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed", PENDING: "pending" };
      return list.map((r) => ({ id: String(r.id), author: r.user?.login ?? "ghost", state: states[r.state] ?? "commented", body: r.body ?? "", commitId: r.commit_id, submittedAt: r.submitted_at }));
    },

    async getChecks(pr) {
      const runs = await t.request("GET", `${base}/commits/${pr.headSha}/check-runs`, { query: { per_page: 100 } });
      const status = await t.request("GET", `${base}/commits/${pr.headSha}/status`);
      return githubCiState(runs.data?.check_runs ?? [], status.data?.statuses ?? []);
    },

    async postReview(pr, input): Promise<PostResult> {
      // GitHub refuses approvals and change requests on your own pull request.
      const mine = pr.author.toLowerCase() === (await self.whoami()).toLowerCase();
      const event: VerdictEvent = mine ? "comment" : input.event;
      const send = (body: string, comments: typeof input.comments) =>
        t.request("POST", `${base}/pulls/${pr.number}/reviews`, {
          body: { commit_id: input.headSha, event: EVENT[event], body, comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })) },
        });
      try {
        const res = await send(input.body, input.comments);
        return { url: res.data?.html_url, event, inline: input.comments.length, movedToBody: 0 };
      } catch (e) {
        // A line GitHub won't accept (422) shouldn't lose the review: post everything in the body.
        if (!(e instanceof HostError) || e.status !== 422 || input.comments.length === 0) throw e;
        const moved = input.comments.map((c) => `- \`${c.path}:${c.line}\`\n\n${c.body.replace(/^/gm, "  ")}`).join("\n\n");
        const res = await send(`${input.body}\n\n### ${input.fallbackHeading}\n\n${moved}`, []);
        return { url: res.data?.html_url, event, inline: 0, movedToBody: input.comments.length };
      }
    },

    async comment(pr, body) {
      await t.request("POST", `/repos/${repo.slug}/issues/${pr.number}/comments`, { body: { body } });
    },

    async ciLog(job) {
      const res = await t.request("GET", `${base}/actions/jobs/${job}/logs`).catch(() => undefined);
      return typeof res?.data === "string" ? res.data : undefined;
    },

    async reply(pr, threadId, body) {
      if (threadId.startsWith("issue-comment-")) {
        await t.request("POST", `/repos/${repo.slug}/issues/${pr.number}/comments`, { body: { body } });
        return;
      }
      const threads = await self.listThreads(pr.number);
      const first = threads.find((x) => x.id === threadId)?.comments[0];
      if (!first) throw new HostError("not-found", 404, `thread ${threadId} not found`);
      await t.request("POST", `${base}/pulls/${pr.number}/comments/${first.id}/replies`, { body: { body } });
    },

    async resolve(_pr, threadId) {
      const res = await t.request("POST", graphqlUrl, {
        body: { query: "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}", variables: { id: threadId } },
      });
      if (res.data?.errors?.length) throw new HostError("invalid", 200, res.data.errors[0].message);
    },

    async permission(user): Promise<Permission> {
      try {
        const p = (await t.request("GET", `${base}/collaborators/${encodeURIComponent(user)}/permission`)).data?.permission;
        return p === "admin" ? "admin" : p === "write" || p === "maintain" ? "write" : p === "read" || p === "triage" ? "read" : "none";
      } catch (e) {
        if (e instanceof HostError && (e.kind === "not-found" || e.kind === "auth")) return "none";
        throw e;
      }
    },

    async requestReReview(pr, users) {
      const me = (await self.whoami()).toLowerCase();
      const reviewers = [...new Set(users.filter((u) => u.toLowerCase() !== me && !/\[bot\]$/.test(u)))];
      if (reviewers.length === 0) return false;
      await t.request("POST", `${base}/pulls/${pr.number}/requested_reviewers`, { body: { reviewers } });
      return true;
    },

    headRefspec(number, local) {
      return `+refs/pull/${number}/head:${local}`;
    },
  };
  return self;
}
