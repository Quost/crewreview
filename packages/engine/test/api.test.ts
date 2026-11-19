import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@crewreview/i18n";
import { appDirs, ConformanceStore, CrewDaemon, parseConfig, readApiInfo, startApi, Store } from "../src/index.ts";

let home: string;
let server: Awaited<ReturnType<typeof startApi>>;
let crew: CrewDaemon;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "crewreview-api-"));
  const dirs = appDirs({ CREWREVIEW_HOME: home });
  crew = new CrewDaemon({ dirs, config: parseConfig({}), version: "test", ui: createTranslator("en"), store: new Store(":memory:"), conformance: ConformanceStore.in(dirs.state), registry: new Map() });
  server = await startApi({ crew, page: new Response("<html>dashboard</html>", { headers: { "content-type": "text/html" } }), stateDir: dirs.state });
});

afterAll(async () => {
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${server.token}` });

describe("local API", () => {
  test("listens on 127.0.0.1 and leaves its address in a private file", async () => {
    expect(server.url).toStartWith("http://127.0.0.1:");
    const info = await readApiInfo(join(home, "state"));
    expect(info?.port).toBe(server.port);
    if (process.platform !== "win32") expect((await stat(join(home, "state", "api.json"))).mode & 0o777).toBe(0o600);
  });

  test("the page is public, data needs the token", async () => {
    expect(await (await fetch(server.url)).text()).toContain("dashboard");
    expect((await fetch(`${server.url}api/state`)).status).toBe(401);
    expect((await fetch(`${server.url}api/state`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const ok = await fetch(`${server.url}api/state`, { headers: auth() });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: { version: string } }).status.version).toBe("test");
  });

  test("a foreign Host header is refused (DNS rebinding)", async () => {
    const res = await fetch(`${server.url}api/state`, { headers: { ...auth(), host: "evil.example:80" } });
    expect(res.status).toBe(403);
  });

  test("writes need the custom header, so another site can't post a form", async () => {
    expect((await fetch(`${server.url}api/cycle`, { method: "POST", headers: auth() })).status).toBe(400);
    expect((await fetch(`${server.url}api/cycle`, { method: "POST", headers: { ...auth(), "x-crewreview": "1" } })).status).toBe(200);
  });

  test("lists and validation", async () => {
    const h = { ...auth(), "x-crewreview": "1", "content-type": "application/json" };
    expect(await (await fetch(`${server.url}api/inbox`, { headers: auth() })).json()).toEqual([]);
    expect(await (await fetch(`${server.url}api/repos`, { headers: auth() })).json()).toEqual([]);
    const bad = await fetch(`${server.url}api/repos`, { method: "POST", headers: h, body: JSON.stringify({ url: "not a url" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("url");
    expect((await fetch(`${server.url}api/inbox/r999`, { headers: auth() })).status).toBe(404);
  });

  test("the event stream needs the token too", async () => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}api/events?token=${server.token}`);
    const first = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
      ws.onerror = reject;
    });
    expect(first.type).toBe("snapshot");
    ws.close();
    const res = await fetch(`${server.url}api/events`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });
});
