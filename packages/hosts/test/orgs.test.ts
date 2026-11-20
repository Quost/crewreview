import { describe, expect, test } from "bun:test";
import { fixtureTransport, gitlabPathKind, globMatch, ownerOnly, parseOwnerUrl, reposWithOpenPullRequests } from "../src/index.ts";

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
