import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { CrewDaemon, CrewEvent } from "./crew.ts";
import { REVIEW_MODES } from "./repos.ts";

export interface ApiInfo {
  url: string;
  port: number;
  token: string;
  pid: number;
  version: string;
}

export interface ApiOptions {
  crew: CrewDaemon;
  /** The dashboard, as a Bun HTML import. */
  page: unknown;
  port?: number;
  stateDir: string;
  token?: string;
}

export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

function apiFile(stateDir: string): string {
  return join(stateDir, "api.json");
}

/** Where a running daemon listens, if one does. */
export async function readApiInfo(stateDir: string): Promise<ApiInfo | undefined> {
  try {
    const info = JSON.parse(await readFile(apiFile(stateDir), "utf8")) as ApiInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return undefined;
  }
}

interface WsData {
  unsubscribe?: () => void;
}

/**
 * The local API and dashboard. Only 127.0.0.1, only with the right Host header (no DNS rebinding), and every data
 * call needs the token, which the browser gets in the URL fragment so it never reaches a log.
 */
export async function startApi(o: ApiOptions): Promise<ApiInfo & { stop(): Promise<void> }> {
  const token = o.token ?? newToken();
  const crew = o.crew;
  let port = 0;

  const hostOk = (req: Request) => {
    const host = req.headers.get("host") ?? "";
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };
  const authed = (req: Request, url: URL) => {
    const h = req.headers.get("authorization") ?? "";
    if (h.startsWith("Bearer ") && same(h.slice(7), token)) return true;
    // WebSockets can't send headers from a browser: the token comes as a query parameter on this one route.
    return url.pathname === "/api/events" && same(url.searchParams.get("token") ?? "", token);
  };

  async function api(req: Request, url: URL, server: Bun.Server<WsData>): Promise<Response | undefined> {
    const p = url.pathname;
    const m = req.method;
    const body = async () => (m === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, any>));
    if (p === "/api/events") {
      return server.upgrade(req, { data: {} }) ? undefined : json({ error: "upgrade" }, 400);
    }
    if (p === "/api/state" && m === "GET") return json({ status: crew.status(), agents: crew.liveAgents(), log: crew.recentLog() });
    if (p === "/api/cycle" && m === "POST") {
      crew.wake();
      return json({ ok: true });
    }
    if (p === "/api/repos" && m === "GET") return json((await crew.repos()).map(({ ref, ...r }) => ({ ...r, kind: ref.kind, webUrl: ref.webUrl, host: ref.host })));
    if (p === "/api/repos" && m === "POST") {
      const b = await body();
      const mode = REVIEW_MODES.includes(b.mode) ? b.mode : "inbox";
      const r = await crew.addRepo(String(b.url ?? ""), mode);
      return "error" in r ? json(r, 400) : json({ id: r.repo.id, user: r.user });
    }
    const repoMatch = /^\/api\/repos\/([a-z0-9._-]+)$/.exec(p);
    if (repoMatch && m === "PATCH") {
      const b = await body();
      const pick = <T extends string>(v: unknown, list: readonly T[]) => (list.includes(v as T) ? (v as T) : undefined);
      const review = { mode: pick(b.review?.mode, REVIEW_MODES), authors: pick(b.review?.authors, ["others", "all", "mine"] as const) };
      const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
      const attend = { mode: pick(b.attend?.mode, REVIEW_MODES), fromCrew: flag(b.attend?.fromCrew), conflicts: flag(b.attend?.conflicts), ci: flag(b.attend?.ci) };
      const clean = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as Partial<T>;
      const updated = await crew.updateRepo(repoMatch[1]!, { review: clean(review), attend: clean(attend) });
      return updated ? json({ ok: true }) : json({ error: "not-found" }, 404);
    }
    const previewMatch = /^\/api\/repos\/([a-z0-9._-]+)\/preview$/.exec(p);
    if (previewMatch && m === "GET") {
      const pv = await crew.previewRepo(previewMatch[1]!);
      return pv ? json(pv) : json({ error: "not-found" }, 404);
    }
    if (p === "/api/preview" && m === "POST") {
      const pv = await crew.previewUrl(String((await body()).url ?? ""));
      return "error" in pv ? json(pv, 400) : json(pv);
    }
    if (p === "/api/hosts" && m === "GET") return json(await crew.hosts());
    if (repoMatch && m === "DELETE") return (await crew.removeRepo(repoMatch[1]!)) ? json({ ok: true }) : json({ error: "not-found" }, 404);
    if (p === "/api/inbox" && m === "GET") return json(crew.inbox());
    const inboxMatch = /^\/api\/inbox\/([rf]\d+)(?:\/(approve|discard))?$/.exec(p);
    if (inboxMatch && !inboxMatch[2] && m === "GET") {
      const item = await crew.inboxItem(inboxMatch[1]!);
      return item ? json(item) : json({ error: "not-found" }, 404);
    }
    if (inboxMatch?.[2] === "approve" && m === "POST") return json(await crew.approve(inboxMatch[1]!));
    if (inboxMatch?.[2] === "discard" && m === "POST") return json({ ok: await crew.discard(inboxMatch[1]!) });
    if (p === "/api/history" && m === "GET") return json(crew.history(Math.min(200, Number(url.searchParams.get("limit") ?? 50))));
    if (p === "/api/harnesses" && m === "GET") return json(await crew.harnesses());
    if (p === "/api/limits" && m === "GET") return json({ ...crew.limits(), usageToday: await crew.usageToday() });
    return json({ error: "not-found" }, 404);
  }

  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: o.port ?? 0,
    // The page and its scripts are the same for everyone and carry no data or token, so they're served before the
    // Host check below; everything with data is under /api/ and checked.
    routes: { "/": o.page as Bun.HTMLBundle },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!hostOk(req)) return new Response("forbidden", { status: 403 });
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if (!authed(req, url)) return json({ error: "unauthorized" }, 401);
      // A browser page on another site can't send our token; this blocks cross-site form posts as well.
      if (req.method !== "GET" && req.headers.get("x-crewreview") !== "1") return json({ error: "missing header" }, 400);
      try {
        return await api(req, url, srv);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        ws.send(JSON.stringify({ type: "snapshot", status: crew.status(), agents: crew.liveAgents(), log: crew.recentLog() }));
        ws.data.unsubscribe = crew.subscribe((e: CrewEvent) => ws.send(JSON.stringify(e)));
      },
      message() {},
      close(ws: ServerWebSocket<WsData>) {
        ws.data.unsubscribe?.();
      },
    },
  });
  port = server.port ?? 0;
  const info: ApiInfo = { url: `http://127.0.0.1:${port}/`, port, token, pid: process.pid, version: crew.o.version };
  await mkdir(o.stateDir, { recursive: true });
  await writeFile(apiFile(o.stateDir), JSON.stringify(info), { mode: 0o600 });
  await chmod(apiFile(o.stateDir), 0o600).catch(() => {});
  return {
    ...info,
    async stop() {
      server.stop(true);
      await rm(apiFile(o.stateDir), { force: true });
    },
  };
}

/** The address to open in a browser: the token travels in the fragment, which browsers never send to a server. */
export function dashboardUrl(info: ApiInfo): string {
  return `${info.url}#token=${info.token}`;
}
