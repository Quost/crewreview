import { parseMarker, type CiState, type PullRequest } from "@crewreview/core";
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
    conflicts: m.has_conflicts === true || m.detailed_merge_status === "conflict" ? true : m.has_conflicts === false ? false : undefined,
  };
}

/** Pipeline jobs to one CI state. A failed job marked allow_failure isn't a pass: it's green with a warning. */
export function gitlabCiState(jobs: any[]): Checks {
  if (jobs.length === 0) return { state: "none", failing: [] };
  const failing: Checks["failing"] = [];
  let running = false;
  for (const j of jobs) {
    if (["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"].includes(j.status)) running = true;
    else if (j.status === "failed") failing.push({ name: j.name, url: j.web_url, allowedToFail: Boolean(j.allow_failure), ...(j.id ? { job: String(j.id) } : {}) });
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

    async defaultBranch() {
      return String((await t.request("GET", project)).data.default_branch);
    },

    async openPullRequest(input) {
      // GitLab marks a draft by its title.
      const title = input.draft ? `Draft: ${input.title}` : input.title;
      const d = (await t.request("POST", `${project}/merge_requests`, { body: { source_branch: input.head, target_branch: input.base, title, description: input.body, remove_source_branch: true } })).data;
      return { number: Number(d.iid), url: String(d.web_url) };
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
      // Drafts a failed attempt left behind are ours by their hidden marker: they go first, so a retry doesn't post
      // twice. Drafts you wrote yourself stay, and then ours are published one by one, never with yours.
      let yours = 0;
      try {
        const existing = ((await t.request("GET", `${mr}/draft_notes`, { query: { per_page: 100 } })).data ?? []) as { id: number; note?: string }[];
        for (const d of existing) {
          if (parseMarker(d.note ?? "")) await t.request("DELETE", `${mr}/draft_notes/${d.id}`).catch(() => {});
          else yours++;
        }
      } catch (e) {
        if (e instanceof HostError && e.status === 404) drafts = false; // older GitLab without draft notes
        else throw e;
      }
      // GitLab can answer 500 to a batch publish and still publish it. The same report renders the same text, so what
      // an earlier attempt already published is skipped here instead of posted twice.
      const published = new Set<string>();
      try {
        const path = `${mr}/notes`;
        const q = { per_page: 100 };
        for (const n of await paginate<{ body?: string; system?: boolean }>(t, path, q, nextPage(path, q), 1000)) {
          if (!n.system && n.body && parseMarker(n.body)) published.add(n.body.trim());
        }
      } catch {
        // Can't tell what's there: post as if nothing were.
      }
      const created: { id: number; c: InlineComment }[] = [];
      for (const c of input.comments) {
        if (published.has(c.body.trim())) {
          placed++;
          continue;
        }
        if (!refs) {
          unplaced.push(c);
          continue;
        }
        // GitLab wants both paths, and both line numbers on an unchanged line; without them a note can be saved as a
        // draft and still fail when it's published.
        const position = {
          position_type: "text",
          base_sha: refs.baseSha,
          start_sha: refs.startSha,
          head_sha: refs.headSha,
          old_path: c.oldPath ?? c.path,
          new_path: c.path,
          new_line: c.line,
          ...(c.oldLine ? { old_line: c.oldLine } : {}),
        };
        try {
          if (drafts) {
            const d = (await t.request("POST", `${mr}/draft_notes`, { body: { note: c.body, position } })).data as { id: number; line_code?: string | null };
            // GitLab saves a draft it can't place on a diff line, then fails the whole batch publishing it (a 500 on
            // 19.x). It says so with an empty line_code: that note goes into the summary instead.
            if (d && "line_code" in d && !d.line_code) {
              await t.request("DELETE", `${mr}/draft_notes/${d.id}`).catch(() => {});
              unplaced.push(c);
            } else created.push({ id: d.id, c });
          } else {
            await t.request("POST", `${mr}/discussions`, { body: { body: c.body, position } });
            placed++;
          }
        } catch {
          unplaced.push(c);
        }
      }
      if (created.length) {
        let left = created;
        if (yours === 0) {
          try {
            await t.request("POST", `${mr}/draft_notes/bulk_publish`);
            left = [];
          } catch {
            // Some GitLab versions fail the whole batch for one note. Whatever is still a draft goes one by one.
            const still = new Set((((await t.request("GET", `${mr}/draft_notes`, { query: { per_page: 100 } }).catch(() => ({ data: [] }))).data ?? []) as { id: number }[]).map((d) => d.id));
            left = created.filter((d) => still.has(d.id));
          }
        }
        placed += created.length - left.length;
        for (const d of left) {
          try {
            await t.request("PUT", `${mr}/draft_notes/${d.id}/publish`);
            placed++;
          } catch {
            // A note GitLab won't place goes into the summary, and its draft away.
            await t.request("DELETE", `${mr}/draft_notes/${d.id}`).catch(() => {});
            unplaced.push(d.c);
          }
        }
      }
      const moved = unplaced.map((c) => `- \`${c.path}:${c.line}\`\n\n${c.body.replace(/^/gm, "  ")}`).join("\n\n");
      const body = unplaced.length ? `${input.body}\n\n### ${input.fallbackHeading}\n\n${moved}` : input.body;
      if (!published.has(body.trim())) await t.request("POST", `${mr}/notes`, { body: { body } });
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

    async comment(pr, body) {
      await t.request("POST", `${project}/merge_requests/${pr.number}/notes`, { body: { body } });
    },

    async editComment(pr, commentId, body) {
      await t.request("PUT", `${project}/merge_requests/${pr.number}/notes/${encodeURIComponent(commentId)}`, { body: { body } });
    },

    async ciLog(job) {
      const res = await t.request("GET", `${project}/jobs/${job}/trace`).catch(() => undefined);
      return typeof res?.data === "string" ? res.data : undefined;
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

    async requestReReview() {
      // The REST API has no re-request; the reply on each thread notifies the reviewer.
      return false;
    },

    headRefspec(number, local) {
      return `+refs/merge-requests/${number}/head:${local}`;
    },
  };
  return self;
}
