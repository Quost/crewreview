import { describe, expect, test } from "bun:test";
import { countRepos as count, fixtureTransport, fixtureTransport as fixture, gitlabPathKind, globMatch, ownerOnly, parseOwnerUrl, repoRef as ref, reposWithOpenPullRequests, signedInHosts } from "../src/index.ts";

const item = (repo: string, n: number) => ({ number: n, repository_url: `https://api.github.com/repos/${repo}` });

describe("organizations", () => {
  test("addresses: an organization, a GitLab group, and what isn't one", () => {
    expect(parseOwnerUrl("https://github.com/acme/").slug).toBe("acme");
    expect(parseOwnerUrl("acme").webUrl).toBe("https://github.com/acme");
    expect(parseOwnerUrl("https://gitlab.example.com/acme/platform", "gitlab")).toMatchObject({ slug: "acme/platform", apiBase: "https://gitlab.example.com/api/v4" });
    expect(() => parseOwnerUrl("https://github.com/acme/shop")).toThrow(/not an organization/);
    expect([ownerOnly("https://github.com/acme"), ownerOnly("https://github.com/acme/shop"), ownerOnly("not a url")]).toEqual([true, false, false]);
  });

  test("GitHub: one search lists the repositories with open pull requests, newest first, without duplicates", async () => {
    const t = fixtureTransport({
      "GET /search/issues?page=1": { items: [...Array.from({ length: 98 }, (_, i) => item("acme/shop", i)), item("acme/api", 200), item("acme/web", 201)] },
      "GET /search/issues?page=2": { items: [item("acme/api", 300), item("acme/docs", 301)] },
    });
    expect(await reposWithOpenPullRequests(parseOwnerUrl("https://github.com/acme"), t)).toEqual(["acme/shop", "acme/api", "acme/web", "acme/docs"]);
    expect(t.calls.map((c) => c.query?.q)).toEqual(["is:pr is:open archived:false user:acme", "is:pr is:open archived:false user:acme"]);
    expect(t.calls[0]?.query).toMatchObject({ sort: "updated", order: "desc", per_page: 100 });
  });

  test("GitLab: the group's merge requests, subgroups included, stopping at the page limit", async () => {
    const mr = (path: string, n: number) => ({ iid: n, references: { full: `${path}!${n}` }, web_url: `https://gitlab.com/${path}/-/merge_requests/${n}` });
    const full = Array.from({ length: 100 }, (_, i) => mr(i % 2 ? "acme/platform/api" : "acme/web", i));
    const t = fixtureTransport({ "GET /groups/acme/merge_requests?page=1": full, "GET /groups/acme/merge_requests?page=2": full, "GET /groups/acme/merge_requests?page=3": [mr("acme/late", 1)] });
    expect(await reposWithOpenPullRequests(parseOwnerUrl("https://gitlab.com/acme", "gitlab"), t, 2)).toEqual(["acme/web", "acme/platform/api"]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.query).toMatchObject({ state: "opened", non_archived: true });
  });

  test("GitLab tells a project from a group", async () => {
    const t = fixtureTransport({ "GET /projects/acme%2Fplatform": { status: 404, data: { message: "404 Project Not Found" } }, "GET /groups/acme%2Fplatform": { id: 7 } });
    expect(await gitlabPathKind(parseOwnerUrl("https://gitlab.com/acme/platform", "gitlab"), t)).toBe("group");
    const p = fixtureTransport({ "GET /projects/acme%2Fapi": { id: 9 } });
    expect(await gitlabPathKind(parseOwnerUrl("https://gitlab.com/acme/api", "gitlab"), p)).toBe("project");
  });

  test("name filters", () => {
    expect(globMatch("svc-*", "svc-billing")).toBe(true);
    expect(globMatch("svc-*", "platform/svc-billing")).toBe(false);
    expect(globMatch("**/svc-*", "platform/svc-billing")).toBe(true);
    expect(globMatch("Legacy?", "legacy2")).toBe(true);
    expect(globMatch("a.b", "axb")).toBe(false);
  });
});


test("counts an owner's repositories: GitLab subgroups included, from the total header", async () => {
  const gl = fixture({ "GET /groups/acme%2Fplatform/projects": { status: 200, data: [{}], headers: { "x-total": "47" } } });
  expect(await count(ref("gitlab", "gitlab.acme.dev", "acme/platform"), gl)).toBe(47);
  expect(gl.calls[0]?.query).toMatchObject({ include_subgroups: true, archived: false });
  const gh = fixture({ "GET /search/repositories": { total_count: 12, items: [] } });
  expect(await count(ref("github", "github.com", "acme"), gh)).toBe(12);
});

test("the hosts gh and glab hold a login for, by name only", async () => {
  const glab = "gitlab.com\n  x gitlab.com: API call failed: 401\ngitlab.acme.dev\n  ✓ Logged in to gitlab.acme.dev as ana (keyring)\n";
  const run = async (argv: string[]) => (argv[0] === "gh" ? "github.com\nghe.acme.dev\n" : glab);
  expect(await signedInHosts(run)).toEqual([
    { kind: "github", host: "github.com" },
    { kind: "github", host: "ghe.acme.dev" },
    // gitlab.com is configured but its token fails: not a host anyone uses.
    { kind: "gitlab", host: "gitlab.acme.dev" },
  ]);
});
