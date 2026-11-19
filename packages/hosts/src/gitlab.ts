import type { CiState, PullRequest } from "@crewreview/core";
import { HostError, paginate, type HttpResponse, type Transport } from "./transport.ts";
import type { Checks, HostAdapter, InlineComment, Permission, PostResult, RepoRef, Thread } from "./types.ts";

function nextPage(path: string, query: Record<string, string | number>) {
  return (res: HttpResponse) => {
    const n = res.headers.get("x-next-page");
    return n ? { path, query: { ...query, page: n } } : undefined;
  };
}

const BOT = /(^|[-_])bot($|[-_\d])|\[bot\]$|^project_\d+_bot/i;

function mapMr(m: any): PullRequest {
  return {
    number: m.iid,
    title: m.title ?? "",
    body: m.description ?? "",
    author: m.author?.username ?? "",
    authorIsBot: Boolean(m.author?.bot) || BOT.test(m.author?.username ?? ""),
    draft: Boolean(m.draft ?? m.work_in_progress),
    state: m.state === "opened" ? "open" : m.state === "merged" ? "merged" : "closed",
    headSha: m.sha ?? m.diff_refs?.head_sha ?? "",
    headRef: m.source_branch ?? "",
    baseRef: m.target_branch ?? "",
    baseSha: m.diff_refs?.base_sha,
    labels: (m.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)),
    updatedAt: m.updated_at ?? "",
    url: m.web_url ?? "",
    fromFork: m.source_project_id !== undefined && m.target_project_id !== undefined && m.source_project_id !== m.target_project_id,
    diffRefs: m.diff_refs ? { baseSha: m.diff_refs.base_sha, startSha: m.diff_refs.start_sha, headSha: m.diff_refs.head_sha } : undefined,
  };
}

/** Pipeline jobs to one CI state. A failed job marked allow_failure isn't a pass: it's green with a warning. */
export function gitlabCiState(jobs: any[]): Checks {
  if (jobs.length === 0) return { state: "none", failing: [] };
  const failing: Checks["failing"] = [];
  let running = false;
  for (const j of jobs) {
    if (["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"].includes(j.status)) running = true;
    else if (j.status === "failed") failing.push({ name: j.name, url: j.web_url, allowedToFail: Boolean(j.allow_failure) });
  }
  const hard = failing.some((f) => !f.allowedToFail);
  const state: CiState = hard ? "red" : running ? "running" : failing.length ? "green-with-warnings" : "green";
  return { state, failing };
}

export function gitlabHost(repo: RepoRef, t: Transport): HostAdapter {
  const project = `/projects/${encodeURIComponent(repo.slug)}`;
  let me: string | undefined;

  const self: HostAdapter = {
    repo,

    async whoami() {
      me ??= (await t.request("GET", "/user")).data.username as string;
      return me;
    },

    async listOpenPullRequests() {
      const q = { state: "opened", per_page: 100 };
      const list = await paginate<any>(t, `${project}/merge_requests`, q, nextPage(`${project}/merge_requests`, q), 500);
      return list.map(mapMr);
    },

    async getPullRequest(number) {
      return mapMr((await t.request("GET", `${project}/merge_requests/${number}`)).data);
    },

    async listThreads(number) {
      const path = `${project}/merge_requests/${number}/discussions`;
      const q = { per_page: 100 };
      const list = await paginate<any>(t, path, q, nextPage(path, q), 1000);
      const out: Thread[] = [];
      for (const d of list) {
        const notes = (d.notes ?? []).filter((n: any) => !n.system);
        if (notes.length === 0) continue;
        const first = notes[0];
        out.push({
          id: String(d.id),
          path: first.position?.new_path ?? first.position?.old_path ?? undefined,
          line: first.position?.new_line ?? first.position?.old_line ?? undefined,
          resolvable: Boolean(first.resolvable),
          resolved: Boolean(first.resolved),
          outdated: false,
          comments: notes.map((n: any) => ({
            id: String(n.id),
            author: n.author?.username ?? "ghost",
            authorIsBot: Boolean(n.author?.bot) || BOT.test(n.author?.username ?? ""),
            body: n.body ?? "",
            createdAt: n.created_at,
          })),
        });
      }
      return out;
    },

    async listReviews(number) {
      const a = (await t.request("GET", `${project}/merge_requests/${number}/approvals`)).data;
      return (a?.approved_by ?? []).map((x: any, i: number) => ({ id: `approval-${i}`, author: x.user?.username ?? "", state: "approved" as const, body: "" }));
    },

    async getChecks(pr) {
      const pipes = (await t.request("GET", `${project}/pipelines`, { query: { sha: pr.headSha, per_page: 1, order_by: "id", sort: "desc" } })).data ?? [];
      const latest = pipes[0];
      if (!latest) return { state: "none", failing: [] };
      const path = `${project}/pipelines/${latest.id}/jobs`;
      const q = { per_page: 100 };
      return gitlabCiState(await paginate<any>(t, path, q, nextPage(path, q), 500));
    },

    async postReview(pr, input): Promise<PostResult> {
      const full = pr.diffRefs ? pr : await self.getPullRequest(pr.number);
      const refs = full.diffRefs;
      const mr = `${project}/merge_requests/${pr.number}`;
      const unplaced: InlineComment[] = [];
      let placed = 0;
      // Draft notes publish together, like a GitHub review: one notification, not one per comment.
      let drafts = true;
      for (const c of input.comments) {
        if (!refs) {
          unplaced.push(c);
          continue;
        }
        const position = { position_type: "text", base_sha: refs.baseSha, start_sha: refs.startSha, head_sha: refs.headSha, new_path: c.path, new_line: c.line };
        try {
          if (drafts) await t.request("POST", `${mr}/draft_notes`, { body: { note: c.body, position } });
          else await t.request("POST", `${mr}/discussions`, { body: { body: c.body, position } });
          placed++;
        } catch (e) {
          if (drafts && e instanceof HostError && e.status === 404) {
            drafts = false; // older GitLab without draft notes
            try {
              await t.request("POST", `${mr}/discussions`, { body: { body: c.body, position } });
              placed++;
            } catch {
              unplaced.push(c);
            }
          } else unplaced.push(c);
        }
      }
      const moved = unplaced.map((c) => `- \`${c.path}:${c.line}\`\n\n${c.body.replace(/^/gm, "  ")}`).join("\n\n");
      const body = unplaced.length ? `${input.body}\n\n### ${input.fallbackHeading}\n\n${moved}` : input.body;
      if (drafts) {
        await t.request("POST", `${mr}/draft_notes`, { body: { note: body } });
        await t.request("POST", `${mr}/draft_notes/bulk_publish`);
      } else {
        await t.request("POST", `${mr}/notes`, { body: { body } });
      }
      let event = input.event;
      if (event === "approve") {
        const mine = pr.author.toLowerCase() === (await self.whoami()).toLowerCase();
        if (mine) event = "comment";
        else await t.request("POST", `${mr}/approve`, { body: { sha: input.headSha } });
      }
      // GitLab has no "request changes" on a note; the summary carries the verdict.
      if (event === "request_changes") event = "comment";
      return { url: full.url, event, inline: placed, movedToBody: unplaced.length };
    },

    async reply(pr, threadId, body) {
      await t.request("POST", `${project}/merge_requests/${pr.number}/discussions/${threadId}/notes`, { body: { body } });
    },

    async resolve(pr, threadId) {
      await t.request("PUT", `${project}/merge_requests/${pr.number}/discussions/${threadId}`, { query: { resolved: true } });
    },

    async permission(user): Promise<Permission> {
      const members = (await t.request("GET", `${project}/members/all`, { query: { query: user, per_page: 20 } })).data ?? [];
      const m = members.find((x: any) => String(x.username).toLowerCase() === user.toLowerCase());
      const level = Number(m?.access_level ?? 0);
      return level >= 40 ? "admin" : level >= 30 ? "write" : level >= 10 ? "read" : "none";
    },

    headRefspec(number, local) {
      return `+refs/merge-requests/${number}/head:${local}`;
    },
  };
  return self;
}
