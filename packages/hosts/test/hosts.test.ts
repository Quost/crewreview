import { describe, expect, test } from "bun:test";
import {
  createHost,
  fixtureTransport,
  gitAuthEnv,
  githubCiState,
  gitlabCiState,
  parseRepoUrl,
  repoRef,
  HostError,
  type HostAdapter,
  type RequestOptions,
} from "../src/index.ts";

describe("repository URLs", () => {
  test("https, ssh, pull request pages and shorthand", () => {
    expect(parseRepoUrl("https://github.com/Quost/crewreview/pull/12")).toMatchObject({ kind: "github", slug: "Quost/crewreview", apiBase: "https://api.github.com" });
    expect(parseRepoUrl("git@github.com:Quost/crewreview.git").slug).toBe("Quost/crewreview");
    expect(parseRepoUrl("https://gitlab.com/group/sub/proj/-/merge_requests/3")).toMatchObject({ kind: "gitlab", slug: "group/sub/proj", apiBase: "https://gitlab.com/api/v4" });
    expect(parseRepoUrl("ssh://git@gitlab.example.com:2222/team/app.git")).toMatchObject({ kind: "gitlab", host: "gitlab.example.com" });
    expect(parseRepoUrl("Quost/crewreview").host).toBe("github.com");
    expect(parseRepoUrl("https://code.acme.io/team/app", "github").apiBase).toBe("https://code.acme.io/api/v3");
    expect(() => parseRepoUrl("https://code.acme.io/team/app")).toThrow();
    expect(() => parseRepoUrl("https://github.com/only-owner")).toThrow();
  });

  test("git auth goes in env config, not on the command line", () => {
    const env = gitAuthEnv(repoRef("github", "github.com", "o/r"), "tok");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(" ").at(-1)!, "base64").toString()).toBe("x-access-token:tok");
  });
});

describe("CI state", () => {
  test("GitHub: any failure is red, anything pending is running", () => {
    expect(githubCiState([], []).state).toBe("none");
    expect(githubCiState([{ status: "completed", conclusion: "success" }], [{ state: "success" }]).state).toBe("green");
    expect(githubCiState([{ status: "in_progress" }], []).state).toBe("running");
    expect(githubCiState([{ status: "completed", conclusion: "failure", name: "test" }, { status: "queued" }], []).state).toBe("red");
    expect(githubCiState([{ status: "completed", conclusion: "skipped" }], [{ state: "error", context: "ci/legacy" }]).failing[0]?.name).toBe("ci/legacy");
  });

  test("GitLab: allow_failure that failed is green with a warning, not a pass", () => {
    expect(gitlabCiState([{ status: "success" }, { status: "failed", allow_failure: true, name: "secrets" }]).state).toBe("green-with-warnings");
    expect(gitlabCiState([{ status: "failed", allow_failure: false, name: "test" }]).state).toBe("red");
    expect(gitlabCiState([{ status: "running" }, { status: "success" }]).state).toBe("running");
    expect(gitlabCiState([{ status: "success" }, { status: "manual" }]).state).toBe("green");
  });
});

// The same contract for both hosts: given recorded API answers, the adapter returns the normalized model.
interface Scenario {
  name: string;
  host: HostAdapter;
  calls: { method: string; path: string; body?: unknown }[];
}

function github(overrides: Record<string, unknown> = {}): Scenario {
  const repo = repoRef("github", "github.com", "acme/shop");
  const t = fixtureTransport({
    "GET /user": { login: "quost" },
    "GET /repos/acme/shop/pulls": [
      { number: 7, title: "Add search", body: "Adds search.", user: { login: "ana", type: "User" }, draft: false, state: "open", head: { sha: "h7", ref: "search", repo: { full_name: "ana/shop" } }, base: { sha: "b7", ref: "main", repo: { full_name: "acme/shop" } }, labels: [{ name: "feature" }], updated_at: "2026-11-19T10:00:00Z", html_url: "https://github.com/acme/shop/pull/7" },
      { number: 8, title: "Bump deps", body: null, user: { login: "dependabot[bot]", type: "Bot" }, draft: true, state: "open", head: { sha: "h8", ref: "deps" }, base: { ref: "main" }, labels: [], updated_at: "", html_url: "" },
    ],
    "GET /repos/acme/shop/pulls/7": { number: 7, title: "Add search", user: { login: "ana" }, state: "open", head: { sha: "h7", ref: "search" }, base: { ref: "main" }, labels: [] },
    "POST https://api.github.com/graphql": {
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { id: "T1", isResolved: false, isOutdated: false, path: "src/search.ts", line: 12, comments: { nodes: [{ databaseId: 101, body: "Escape the query?", createdAt: "2026-11-19T10:05:00Z", author: { login: "bia", __typename: "User" } }] } },
      ] } } } },
    },
    "GET /repos/acme/shop/issues/7/comments": [{ id: 55, body: "LGTM overall", user: { login: "bia", type: "User" }, created_at: "2026-11-19T10:06:00Z" }],
    "GET /repos/acme/shop/pulls/7/reviews": [{ id: 9, user: { login: "bia" }, state: "CHANGES_REQUESTED", body: "see comments", commit_id: "h7" }],
    "GET /repos/acme/shop/commits/h7/check-runs": { check_runs: [{ name: "test", status: "completed", conclusion: "failure", html_url: "u" }] },
    "GET /repos/acme/shop/commits/h7/status": { statuses: [] },
    "POST /repos/acme/shop/pulls/7/reviews": { html_url: "https://github.com/acme/shop/pull/7#review-1" },
    "GET /repos/acme/shop/collaborators/bia/permission": { permission: "maintain" },
    "POST /repos/acme/shop/pulls/7/requested_reviewers": {},
    "GET /repos/acme/shop/collaborators/eve/permission": { status: 404, data: { message: "Not Found" } },
    ...overrides,
  });
  return { name: "github", host: createHost(repo, t), calls: t.calls };
}

function gitlab(overrides: Record<string, unknown> = {}): Scenario {
  const repo = repoRef("gitlab", "gitlab.com", "acme/shop");
  const p = "/projects/acme%2Fshop";
  const t = fixtureTransport({
    "GET /user": { username: "quost" },
    [`GET ${p}/merge_requests`]: [
      { iid: 7, title: "Add search", description: "Adds search.", author: { username: "ana" }, draft: false, state: "opened", sha: "h7", source_branch: "search", target_branch: "main", labels: ["feature"], updated_at: "2026-11-19T10:00:00Z", web_url: "https://gitlab.com/acme/shop/-/merge_requests/7", source_project_id: 2, target_project_id: 1 },
      { iid: 8, title: "Bump deps", description: null, author: { username: "renovate-bot" }, work_in_progress: true, state: "opened", sha: "h8", source_branch: "deps", target_branch: "main", labels: [], updated_at: "", web_url: "" },
    ],
    [`GET ${p}/merge_requests/7`]: { iid: 7, title: "Add search", author: { username: "ana" }, state: "opened", sha: "h7", source_branch: "search", target_branch: "main", labels: [], web_url: "https://gitlab.com/acme/shop/-/merge_requests/7", diff_refs: { base_sha: "b7", start_sha: "s7", head_sha: "h7" } },
    [`GET ${p}/merge_requests/7/discussions`]: [
      { id: "T1", notes: [{ id: 101, body: "Escape the query?", author: { username: "bia" }, system: false, resolvable: true, resolved: false, position: { new_path: "src/search.ts", new_line: 12 }, created_at: "2026-11-19T10:05:00Z" }] },
      { id: "S1", notes: [{ id: 102, body: "added 1 commit", system: true }] },
      { id: "C1", notes: [{ id: 55, body: "LGTM overall", author: { username: "bia" }, system: false, resolvable: false, created_at: "2026-11-19T10:06:00Z" }] },
    ],
    [`GET ${p}/merge_requests/7/approvals`]: { approved_by: [] },
    [`GET ${p}/pipelines`]: [{ id: 900 }],
    [`GET ${p}/pipelines/900/jobs`]: [{ name: "test", status: "failed", allow_failure: false, web_url: "u" }],
    [`GET ${p}/merge_requests/7/draft_notes`]: [],
    [`POST ${p}/merge_requests/7/draft_notes`]: { id: 1 },
    [`POST ${p}/merge_requests/7/draft_notes/bulk_publish`]: { status: 204, data: null },
    [`POST ${p}/merge_requests/7/notes`]: { id: 9 },
    [`GET ${p}/members/all`]: [{ username: "bia", access_level: 40 }],
    ...overrides,
  });
  return { name: "gitlab", host: createHost(repo, t), calls: t.calls };
}

for (const make of [github, gitlab]) {
  describe(`${make().name} adapter contract`, () => {
    test("lists open pull requests in the shared model", async () => {
      const s = make();
      const list = await s.host.listOpenPullRequests();
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ number: 7, title: "Add search", author: "ana", authorIsBot: false, draft: false, state: "open", headSha: "h7", headRef: "search", baseRef: "main", labels: ["feature"], fromFork: true });
      expect(list[1]).toMatchObject({ number: 8, authorIsBot: true, draft: true, body: "" });
      expect(await s.host.whoami()).toBe("quost");
    });

    test("threads: inline discussions and conversation comments, system notes left out", async () => {
      const s = make();
      const threads = await s.host.listThreads(7);
      const inline = threads.find((t) => t.path)!;
      expect(inline).toMatchObject({ id: "T1", path: "src/search.ts", line: 12, resolvable: true, resolved: false });
      expect(inline.comments[0]).toMatchObject({ id: "101", author: "bia", body: "Escape the query?" });
      const convo = threads.filter((t) => !t.path);
      expect(convo).toHaveLength(1);
      expect(convo[0]!.comments[0]!.body).toBe("LGTM overall");
    });

    test("checks of the head", async () => {
      const s = make();
      const pr = await s.host.getPullRequest(7);
      expect((await s.host.getChecks(pr)).state).toBe("red");
    });

    test("posts a review with inline comments", async () => {
      const s = make();
      const pr = await s.host.getPullRequest(7);
      const r = await s.host.postReview(pr, {
        headSha: "h7",
        event: "request_changes",
        body: "Summary",
        comments: [{ path: "src/search.ts", line: 12, body: "Injection" }],
        fallbackHeading: "Outside the diff",
      });
      expect(r.inline).toBe(1);
      expect(r.movedToBody).toBe(0);
      const posts = s.calls.filter((c) => c.method === "POST" && !c.path.includes("graphql"));
      expect(posts.length).toBeGreaterThan(0);
      expect(JSON.stringify(posts.map((c) => c.body))).toContain("Injection");
      expect(JSON.stringify(posts.map((c) => c.body))).toContain("Summary");
    });

    test("permissions", async () => {
      const s = make();
      expect(await s.host.permission("bia")).toBe(s.name === "github" ? "write" : "admin");
      expect(await s.host.permission("eve")).toBe("none");
    });

    test("re-review requests skip you and bots", async () => {
      const s = make();
      const pr = await s.host.getPullRequest(7);
      const asked = await s.host.requestReReview(pr, ["bia", "quost", "copilot[bot]"]);
      if (s.name === "github") {
        expect(asked).toBe(true);
        expect(s.calls.find((c) => c.path.endsWith("/requested_reviewers"))?.body).toEqual({ reviewers: ["bia"] });
      } else expect(asked).toBe(false);
    });

    test("head refspec", () => {
      expect(make().host.headRefspec(7, "refs/crewreview/head")).toContain("/7/head:refs/crewreview/head");
    });
  });
}

describe("host-specific behavior", () => {
  test("GitHub: your own pull request gets a comment, never an approval", async () => {
    const s = github({ "GET /repos/acme/shop/pulls/7": { number: 7, user: { login: "Quost" }, state: "open", head: { sha: "h7" }, base: {}, labels: [] } });
    const pr = await s.host.getPullRequest(7);
    const r = await s.host.postReview(pr, { headSha: "h7", event: "approve", body: "ok", comments: [], fallbackHeading: "x" });
    expect(r.event).toBe("comment");
    expect((s.calls.find((c) => c.path.endsWith("/reviews") && c.method === "POST")!.body as any).event).toBe("COMMENT");
  });

  test("GitHub: a 422 on inline comments moves them into the body", async () => {
    const t = failOnce(fixtureTransport({ "GET /user": { login: "quost" }, "POST /repos/acme/shop/pulls/7/reviews": { html_url: "u" } }), (m, p) => m === "POST" && p.endsWith("/reviews"), 422);
    const gh = createHost(repoRef("github", "github.com", "acme/shop"), t);
    const pr = { number: 7, author: "ana", headSha: "h7" } as never;
    const r = await gh.postReview(pr, { headSha: "h7", event: "comment", body: "Summary", comments: [{ path: "a.ts", line: 3, body: "x" }], fallbackHeading: "Outside the diff" });
    expect(r).toMatchObject({ inline: 0, movedToBody: 1 });
    const last = t.calls.filter((c) => c.method === "POST").at(-1)!.body as any;
    expect(last.comments).toEqual([]);
    expect(last.body).toContain("### Outside the diff");
    expect(last.body).toContain("`a.ts:3`");
  });

  test("GitLab: a line the diff doesn't have goes to the summary; our draft notes are published together", async () => {
    const p = "/projects/acme%2Fshop";
    const pr = await gitlab().host.getPullRequest(7);
    let inlineCalls = 0;
    const t = failOnce(
      fixtureTransport({
        "GET /user": { username: "quost" },
        [`GET ${p}/merge_requests/7/draft_notes`]: [],
        [`POST ${p}/merge_requests/7/draft_notes`]: { id: 1 },
        [`POST ${p}/merge_requests/7/draft_notes/bulk_publish`]: { status: 204, data: null },
        [`POST ${p}/merge_requests/7/notes`]: { id: 9 },
        [`POST ${p}/merge_requests/7/approve`]: {},
      }),
      (m, path, o) => m === "POST" && path.endsWith("/draft_notes") && Boolean((o?.body as any)?.position) && inlineCalls++ === 1,
      400,
    );
    const gl = createHost(repoRef("gitlab", "gitlab.com", "acme/shop"), t);
    const r = await gl.postReview(pr, {
      headSha: "h7",
      event: "approve",
      body: "Summary",
      comments: [{ path: "a.ts", line: 1, body: "one", oldLine: 1 }, { path: "a.ts", line: 99, body: "two" }],
      fallbackHeading: "Outside the diff",
    });
    expect(r).toMatchObject({ inline: 1, movedToBody: 1, event: "approve" });
    // Both paths always, and the old line on an unchanged line: without them GitLab fails when it publishes.
    const first = t.calls.find((c) => c.path.endsWith("/draft_notes") && (c.body as any)?.position)!.body as any;
    expect(first.position).toMatchObject({ old_path: "a.ts", new_path: "a.ts", new_line: 1, old_line: 1 });
    const summary = t.calls.find((c) => c.path.endsWith("/notes") && c.method === "POST")!.body as any;
    expect(summary.body).toContain("`a.ts:99`");
    expect(t.calls.some((c) => c.path.endsWith("/bulk_publish"))).toBe(true);
    expect(t.calls.some((c) => c.path.endsWith("/approve"))).toBe(true);
  });

  test("GitLab: a retry after a publish GitLab half-did skips what's already there instead of posting it twice", async () => {
    const p = "/projects/acme%2Fshop/merge_requests/7";
    const pr = await gitlab().host.getPullRequest(7);
    const one = "one\n<!-- crewreview:kind=finding;v=0.10.0;ref=F1%40h7 -->";
    const two = "two\n<!-- crewreview:kind=finding;v=0.10.0;ref=F2%40h7 -->";
    const summary = "Summary\n<!-- crewreview:kind=review;v=0.10.0;ref=h7 -->";
    const drafted: string[] = [];
    const posted: string[] = [];
    const t = {
      async request(method: string, path: string, o?: { body?: any }) {
        const ok = (data: unknown) => ({ status: 200, headers: new Headers(), data });
        if (method === "GET" && path === `${p}/draft_notes`) return ok([]);
        // The first attempt got a 500 back, but finding one was published. A note of yours with the same text isn't ours.
        if (method === "GET" && path === `${p}/notes`) return ok([{ body: one, system: false }, { body: "two", system: false }]);
        if (method === "POST" && path === `${p}/draft_notes`) return drafted.push(o?.body?.note), ok({ id: 5, line_code: "abc" });
        if (method === "POST" && path === `${p}/notes`) posted.push(o?.body?.body);
        return ok({});
      },
    };
    const gl = createHost(repoRef("gitlab", "gitlab.com", "acme/shop"), t as never);
    const input = { headSha: "h7", event: "comment" as const, body: summary, comments: [{ path: "a.ts", line: 1, body: one }, { path: "a.ts", line: 2, body: two }], fallbackHeading: "Outside the diff" };
    const r = await gl.postReview(pr, input);
    expect(r).toMatchObject({ inline: 2, movedToBody: 0 });
    expect(drafted).toEqual([two]);
    expect(posted).toEqual([summary]);
  });

  test("GitLab: a retry clears our old drafts, keeps yours, and never publishes yours with ours", async () => {
    const p = "/projects/acme%2Fshop/merge_requests/7";
    const pr = await gitlab().host.getPullRequest(7);
    let nextId = 50;
    const calls: { method: string; path: string }[] = [];
    const t = {
      async request(method: string, path: string) {
        calls.push({ method, path });
        if (method === "GET" && path === `/projects/acme%2Fshop/merge_requests/7/draft_notes`)
          return { status: 200, headers: new Headers(), data: [{ id: 11, note: "old finding\n<!-- crewreview:kind=finding;v=0.10.0 -->" }, { id: 12, note: "my own pending comment" }] };
        if (method === "POST" && path === `${p}/draft_notes`) return { status: 200, headers: new Headers(), data: { id: nextId++ } };
        return { status: 200, headers: new Headers(), data: {} };
      },
    };
    const gl = createHost(repoRef("gitlab", "gitlab.com", "acme/shop"), t as never);
    const r = await gl.postReview(pr, { headSha: "h7", event: "comment", body: "Summary", comments: [{ path: "a.ts", line: 1, body: "new" }], fallbackHeading: "Outside the diff" });
    expect(r.inline).toBe(1);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${p}/draft_notes/11`)).toBe(true);
    expect(calls.some((c) => c.path === `${p}/draft_notes/12` || c.path.endsWith("/bulk_publish"))).toBe(false);
    expect(calls.some((c) => c.method === "PUT" && c.path === `${p}/draft_notes/50/publish`)).toBe(true);
  });

  test("GitLab: a draft it saves without a diff line is taken back before publishing, into the summary", async () => {
    const p = "/projects/acme%2Fshop/merge_requests/7";
    const pr = await gitlab().host.getPullRequest(7);
    let nextId = 90;
    const posted: string[] = [];
    const calls: { method: string; path: string }[] = [];
    const t = {
      async request(method: string, path: string, o?: { body?: any }) {
        calls.push({ method, path });
        const ok = (data: unknown) => ({ status: 200, headers: new Headers(), data });
        if (method === "GET" && path === `${p}/draft_notes`) return ok([]);
        if (method === "POST" && path === `${p}/draft_notes`) {
          const id = nextId++;
          return ok({ id, line_code: o?.body?.position?.new_line === 30 ? null : `abc_${id}` });
        }
        if (method === "POST" && path === `${p}/notes`) posted.push(o?.body?.body);
        return ok({});
      },
    };
    const gl = createHost(repoRef("gitlab", "gitlab.com", "acme/shop"), t as never);
    const r = await gl.postReview(pr, { headSha: "h7", event: "comment", body: "Summary", comments: [{ path: "a.ts", line: 1, body: "placed" }, { path: "a.ts", line: 30, body: "nowhere" }], fallbackHeading: "Outside the diff" });
    expect(r).toMatchObject({ inline: 1, movedToBody: 1 });
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${p}/draft_notes/91`)).toBe(true);
    expect(calls.some((c) => c.path.endsWith("/bulk_publish"))).toBe(true);
    expect(posted[0]).toContain("`a.ts:30`");
  });

  test("GitLab: when publishing the batch fails, our drafts go one by one; one GitLab won't take goes to the summary", async () => {
    const p = "/projects/acme%2Fshop/merge_requests/7";
    const pr = await gitlab().host.getPullRequest(7);
    let nextId = 70;
    let lists = 0;
    const posted: string[] = [];
    const calls: { method: string; path: string }[] = [];
    const t = {
      async request(method: string, path: string, o?: { body?: any }) {
        calls.push({ method, path });
        const ok = (data: unknown) => ({ status: 200, headers: new Headers(), data });
        if (method === "GET" && path === `${p}/draft_notes`) return ok(lists++ === 0 ? [] : [{ id: 70 }, { id: 71 }]);
        if (method === "POST" && path === `${p}/draft_notes`) return ok({ id: nextId++ });
        if (path.endsWith("/bulk_publish")) throw new HostError("server", 500, `POST ${path}: 500 Internal Server Error`);
        if (method === "PUT" && path === `${p}/draft_notes/71/publish`) throw new HostError("server", 500, "500");
        if (method === "POST" && path === `${p}/notes`) posted.push(o?.body?.body);
        return ok({});
      },
    };
    const gl = createHost(repoRef("gitlab", "gitlab.com", "acme/shop"), t as never);
    const r = await gl.postReview(pr, { headSha: "h7", event: "comment", body: "Summary", comments: [{ path: "a.ts", line: 1, body: "fine" }, { path: "b.ts", line: 4, body: "stubborn" }], fallbackHeading: "Outside the diff" });
    expect(r).toMatchObject({ inline: 1, movedToBody: 1 });
    expect(calls.some((c) => c.method === "DELETE" && c.path === `${p}/draft_notes/71`)).toBe(true);
    expect(posted[0]).toContain("`b.ts:4`");
  });
});

/** Wrap a fixture transport so matching calls fail once with an HTTP status (recorded calls stay the same). */
function failOnce<T extends ReturnType<typeof fixtureTransport>>(
  t: T,
  match: (method: string, path: string, options?: RequestOptions) => boolean,
  status: number,
): T {
  const real = t.request.bind(t);
  let failed = false;
  t.request = async (method, path, options) => {
    if (!failed && match(method, path, options)) {
      failed = true;
      throw new HostError("invalid", status, `${method} ${path}: ${status}`);
    }
    return real(method, path, options);
  };
  return t;
}
