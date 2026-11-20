import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOwnerUrl, parseRepoUrl } from "@crewreview/hosts";
import type { PullRequest } from "@crewreview/core";
import { expandOrgs, findLinked, loadRepos, newRepoEntry, parseConfig, previewLink, runCycle, saveRepos, Store, type DaemonEvent, type LinkedRepo, type PrDeps, type PrTarget } from "../src/index.ts";

const org = (url: string, extra: Parameters<typeof newRepoEntry>[1] = {}): LinkedRepo => {
  const ref = parseOwnerUrl(url);
  return { ...newRepoEntry(ref, { scope: "org", review: { mode: "inbox" }, ...extra }), ref };
};
const own = (url: string, mode: "off" | "inbox" | "auto" = "auto"): LinkedRepo => {
  const ref = parseRepoUrl(url);
  return { ...newRepoEntry(ref, { review: { mode } }), ref };
};

describe("organization links", () => {
  test("an organization becomes its repositories with open pull requests, with its settings and filters", async () => {
    const acme = org("https://github.com/acme", { exclude: ["legacy-*"], attend: { mode: "inbox" } });
    const shop = own("https://github.com/acme/shop", "off");
    const errors: string[] = [];
    const list = async (o: LinkedRepo) => (o.id === "acme" ? ["acme/shop", "acme/api", "acme/legacy-app", "other/x"] : Promise.reject(new Error("boom")));
    const out = await expandOrgs([acme, shop, org("https://github.com/broken")], list, (o) => errors.push(o.id));
    expect(out.map((r) => [r.id, r.review.mode, r.org ?? null])).toEqual([
      ["acme-shop", "off", null], // linked on its own: its own settings win
      ["acme-api", "inbox", "acme"],
    ]);
    expect(out[1]?.attend.mode).toBe("inbox");
    expect(out[1]?.ref.webUrl).toBe("https://github.com/acme/api");
    expect(errors).toEqual(["broken"]);
  });

  test("an inbox item from an organization's repository finds its settings by the pull request's address", () => {
    const links = [org("https://github.com/acme", { review: { mode: "auto" } }), own("https://github.com/acme/shop")];
    expect(findLinked(links, "acme-shop")?.org).toBeUndefined();
    expect(findLinked(links, "acme-api", "https://github.com/acme/api/pull/4")).toMatchObject({ id: "acme-api", org: "acme", review: { mode: "auto" } });
    expect(findLinked(links, "acme-api")).toBeUndefined();
    expect(findLinked(links, "other-x", "https://github.com/other/x/pull/1")).toBeUndefined();
  });

  test("repos.toml keeps the scope and filters", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "crewreview-repos-")), "repos.toml");
    const { ref: _r, ...entry } = org("https://github.com/acme", { include: ["svc-*"], exclude: ["svc-old"] });
    await saveRepos(file, [entry]);
    const [back] = await loadRepos(file);
    expect(back).toMatchObject({ id: "acme", scope: "org", include: ["svc-*"], exclude: ["svc-old"], ref: { slug: "acme" } });
    // Paused survives being rebuilt (the dashboard's switch) and saved.
    const { ref: _p, ...paused } = { ...newRepoEntry(parseRepoUrl("https://github.com/acme/shop"), { paused: true }), ref: undefined };
    await saveRepos(file, [paused]);
    expect((await loadRepos(file))[0]).toMatchObject({ id: "acme-shop", paused: true });
  });

  test("a cycle expands organizations before it looks for work", async () => {
    const d = { config: parseConfig({}), version: "test" } as unknown as PrDeps;
    const events: DaemonEvent[] = [];
    const reached: string[] = [];
    await runCycle(
      d,
      [org("https://github.com/acme")],
      (e) => events.push(e),
      Date.now,
      async (r) => (reached.push(r.id), { error: "no-token" as const }),
      async () => ["acme/shop", "acme/api"],
    );
    expect(reached).toEqual(["acme-shop", "acme-api"]);
    expect(events.filter((e) => e.type === "repo-error").map((e) => (e as { repo: string }).repo)).toEqual(["acme-shop", "acme-api"]);
  });

  test("paused links are left alone: a paused repository stays paused inside an active organization", async () => {
    const d = { config: parseConfig({}), version: "test" } as unknown as PrDeps;
    const reached: string[] = [];
    const searched: string[] = [];
    const shop = { ...own("https://github.com/acme/shop"), paused: true };
    const beta = { ...org("https://github.com/beta"), paused: true };
    await runCycle(
      d,
      [org("https://github.com/acme"), shop, beta, { ...own("https://github.com/other/x"), paused: true }, own("https://github.com/other/y")],
      () => {},
      Date.now,
      async (r) => (reached.push(r.id), { error: "no-token" as const }),
      async (o) => (searched.push(o.id), o.id === "acme" ? ["acme/shop", "acme/api"] : ["beta/one"]),
    );
    expect(searched).toEqual(["acme"]);
    expect(reached.sort()).toEqual(["acme-api", "other-y"]);
  });

  test("the preview says what a cycle would review, without recording anything", async () => {
    const store = new Store(":memory:");
    const config = parseConfig({ review: { lenses: ["correctness", "security", "tests"], ciMaxWait: "0s" }, schedule: { maxReviewsPerCycle: 2 }, limits: { dailyRuns: 100 } });
    const d = { config, store, version: "test" } as unknown as PrDeps;
    const pr = (n: number, p: Partial<PullRequest> = {}): PullRequest => ({ number: n, title: `pr ${n}`, body: "", author: "ana", authorIsBot: false, draft: false, state: "open", headSha: `sha${n}`, headRef: "b", baseRef: "main", labels: [], updatedAt: "2026-11-01T00:00:00Z", url: `https://github.com/acme/x/pull/${n}`, fromFork: false, ...p });
    const prs: Record<string, PullRequest[]> = {
      "acme-shop": [pr(1), pr(2, { draft: true }), pr(3, { author: "me" }), pr(4, { authorIsBot: true, author: "dependabot[bot]" })],
      "acme-api": [pr(5), pr(6, { updatedAt: new Date().toISOString() })],
    };
    const connectTo = async (r: LinkedRepo) => ({ repo: r, token: "t", host: { whoami: async () => "me", listOpenPullRequests: async () => prs[r.id] ?? [], getChecks: async () => ({ state: "green", failing: [] }) } }) as unknown as PrTarget;
    const p = await previewLink(d, org("https://github.com/acme"), { connectTo, listOrg: async () => ["acme/shop", "acme/api"] });
    expect(p.wouldReview.map((w) => `${w.repo}#${w.number}`)).toEqual(["acme/shop#1", "acme/api#5"]);
    // Three lenses and the verifier per review; a push from a moment ago is still settling.
    expect({ org: p.org, repos: p.repos, prs: p.pullRequests, runs: p.agentRuns, perCycle: p.perCycle, own: p.ownOpen, budget: p.budget }).toEqual({ org: true, repos: 2, prs: 6, runs: 8, perCycle: 2, own: 1, budget: { used: 0, limit: 100 } });
    expect(p.skipped).toEqual({ draft: 1, own: 1, "bot-author": 1, settling: 1 });
    expect(store.seenAt("acme-shop", 1, "sha1")).toBeUndefined();
  });
});

