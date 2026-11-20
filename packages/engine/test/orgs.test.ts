import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOwnerUrl, parseRepoUrl } from "@crewreview/hosts";
import { expandOrgs, findLinked, loadRepos, newRepoEntry, parseConfig, runCycle, saveRepos, type DaemonEvent, type LinkedRepo, type PrDeps } from "../src/index.ts";

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
});
