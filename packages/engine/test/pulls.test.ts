import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@crewreview/i18n";
import { repoRef } from "@crewreview/hosts";
import { appDirs, ConformanceStore, CrewDaemon, newRepoEntry, parseConfig, reposFile, saveRepos, startApi, Store } from "../src/index.ts";

let home: string;
let server: Awaited<ReturnType<typeof startApi>>;
let crew: CrewDaemon;
let store: Store;
let dirs: ReturnType<typeof appDirs>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "crewreview-pulls-"));
  dirs = appDirs({ CREWREVIEW_HOME: home });
  store = new Store(":memory:");
  crew = new CrewDaemon({ dirs, config: parseConfig({}), version: "test", ui: createTranslator("en"), store, conformance: ConformanceStore.in(dirs.state), registry: new Map() });
  server = await startApi({ crew, page: new Response("<html></html>", { headers: { "content-type": "text/html" } }), stateDir: dirs.state });
});

afterAll(async () => {
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

const h = () => ({ authorization: `Bearer ${server.token}`, "x-crewreview": "1", "content-type": "application/json" });
const post = (path: string, body?: unknown) => fetch(`${server.url}${path}`, { method: "POST", headers: h(), body: JSON.stringify(body ?? {}) });

describe("what waits on you in a pull request", () => {
  test("the store lists what isn't handled, and one item can be tried again", () => {
    store.markItems("acme-shop", 7, ["thread:T1:c1"], "handled");
    store.markItems("acme-shop", 7, ["thread:T2:c2"], "needs-human");
    store.markItems("acme-shop", 7, ["conflict:abc"], "needs-human");
    store.failItems("acme-shop", 7, ["ci:abc"], 1);
    expect(store.blockedItems("acme-shop", 7).map((b) => [b.key, b.status]).sort()).toEqual([
      ["ci:abc", "gave-up"],
      ["conflict:abc", "needs-human"],
      ["thread:T2:c2", "needs-human"],
    ]);
    expect(store.retryItem("acme-shop", 7, "conflict:abc")).toBe(true);
    // A handled item isn't "waiting": trying it again does nothing.
    expect(store.retryItem("acme-shop", 7, "thread:T1:c1")).toBe(false);
    expect(store.attendDone("acme-shop", 7).has("conflict:abc")).toBe(false);
    expect(store.attendDone("acme-shop", 7).has("thread:T1:c1")).toBe(true);
  });

  test("from the dashboard: try one again, or mark it done", async () => {
    const retried = await post("api/pulls/acme-shop/7/retry", { key: "thread:T2:c2" });
    expect(retried.status).toBe(200);
    expect(store.attendDone("acme-shop", 7).has("thread:T2:c2")).toBe(false);
    const done = await post("api/pulls/acme-shop/7/dismiss", { key: "ci:abc" });
    expect(done.status).toBe(200);
    expect(store.blockedItems("acme-shop", 7)).toEqual([]);
    // Done for good: not offered again.
    expect(store.attendDone("acme-shop", 7).has("ci:abc")).toBe(true);
    expect((await post("api/pulls/acme-shop/7/dismiss", { key: "ci:abc" })).status).toBe(404);
    expect((await post("api/pulls/acme-shop/7/retry", {})).status).toBe(400);
    expect((await post("api/pulls/acme-shop/7/retry", { key: "x".repeat(301) })).status).toBe(400);
  });

  test("answer now: only on a linked repository that answers reviews", async () => {
    const nowhere = await post("api/pulls/nope/1/attend");
    expect([nowhere.status, ((await nowhere.json()) as { error: string }).error]).toEqual([404, "not-found"]);
    await saveRepos(reposFile(dirs), [newRepoEntry(repoRef("github", "github.com", "acme/shop"))]);
    const off = await post("api/pulls/acme-shop/1/attend");
    expect([off.status, ((await off.json()) as { error: string }).error]).toEqual([409, "off"]);
    await saveRepos(reposFile(dirs), []);
  });

  test("the list leaves out repositories that don't answer reviews", async () => {
    await saveRepos(reposFile(dirs), [newRepoEntry(repoRef("github", "github.com", "acme/shop"))]);
    const res = await fetch(`${server.url}api/pulls`, { headers: h() });
    expect(await res.json()).toEqual([]);
    await saveRepos(reposFile(dirs), []);
  });

  test("writes need the token and the custom header", async () => {
    expect((await fetch(`${server.url}api/pulls/acme-shop/7/retry`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${server.url}api/pulls/acme-shop/7/retry`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: "{}" })).status).toBe(400);
  });
});
