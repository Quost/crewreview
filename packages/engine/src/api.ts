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
      const attend = { mode: pick(b.attend?.mode, REVIEW_MODES), fromCrew: flag(b.attend?.fromCrew), conflicts: flag(b.attend?.conflicts), ci: flag(b.attend?.ci), protectedFiles: pick(b.attend?.protectedFiles, ["approve", "auto"] as const) };
      const clean = <T extends object>(x: T) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as Partial<T>;
      // A review account is checked before it's saved: its token is found and it isn't you. "" goes back to you.
      let account: string | null | undefined;
      let user: string | undefined;
      if (typeof b.review?.account === "string") {
        const name = b.review.account.trim();
        if (name) {
          const check = await crew.checkAccount(repoMatch[1]!, name);
          if (!check) return json({ error: "not-found" }, 404);
          if ("error" in check) return json({ error: "account", problem: check.error, name: check.name, message: check.message }, 400);
          account = name;
          user = check.user;
        } else account = null;
      }
      // Automatic approvals: true or false for this repository, null to follow the setting for all of them.
      const approve = b.review?.allowApprove === null ? null : flag(b.review?.allowApprove);
      const updated = await crew.updateRepo(repoMatch[1]!, {
        review: { ...clean(review), ...(account !== undefined ? { account } : {}), ...(approve !== undefined ? { allowApprove: approve } : {}) },
        attend: clean(attend),
        paused: flag(b.paused),
      });
      return updated ? json({ ok: true, ...(user ? { user } : {}) }) : json({ error: "not-found" }, 404);
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
    // A second account to post reviews as: check it, invite it, sign it in to gh, accept the invitations.
    if (p === "/api/account/user" && m === "GET") {
      const r = await crew.accountUser(url.searchParams.get("login") ?? "", url.searchParams.get("host") ?? undefined);
      return "error" in r ? json(r, r.error === "not-found" ? 404 : 400) : json(r);
    }
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    if (p === "/api/account/invite" && m === "POST") {
      const b = await body();
      return json(await crew.accountInvite(String(b.login ?? ""), ids(b.repos)));
    }
    if (p === "/api/account/signin" && m === "POST") {
      const b = await body();
      return json(await crew.accountSignIn(String(b.login ?? ""), typeof b.host === "string" ? b.host : undefined));
    }
    if (p === "/api/account/signin" && m === "GET") return json(crew.signInStatus());
    if (p === "/api/account/signin" && m === "DELETE") {
      crew.cancelSignIn();
      return json({ ok: true });
    }
    if (p === "/api/account/accept" && m === "POST") {
      const b = await body();
      const r = await crew.accountAccept(String(b.login ?? ""), ids(b.repos));
      return "error" in r ? json(r, 400) : json(r);
    }
    // A pasted token: it goes to the system keychain and is never written to a file, a log or an answer.
    if (p === "/api/account/token" && m === "POST") {
      const b = await body();
      const r = await crew.accountToken(ids(b.repos), typeof b.token === "string" ? b.token : "", b.reviewOwn === true);
      return "error" in r ? json(r, 400) : json(r);
    }
    if (repoMatch && m === "DELETE") return (await crew.removeRepo(repoMatch[1]!)) ? json({ ok: true }) : json({ error: "not-found" }, 404);
    if (p === "/api/inbox" && m === "GET") return json(crew.inbox());
    const inboxMatch = /^\/api\/inbox\/([rf]\d+)(?:\/(approve|discard))?$/.exec(p);
    if (inboxMatch && !inboxMatch[2] && m === "GET") {
      const item = await crew.inboxItem(inboxMatch[1]!);
      return item ? json(item) : json({ error: "not-found" }, 404);
    }
    if (inboxMatch?.[2] === "approve" && m === "POST") return json(await crew.approve(inboxMatch[1]!));
    if (inboxMatch?.[2] === "discard" && m === "POST") return json({ ok: await crew.discard(inboxMatch[1]!) });
    const resetMatch = /^\/api\/repos\/([a-z0-9._-]+)\/attend\/([0-9]+)\/reset-items$/.exec(p);
    if (resetMatch && m === "POST") {
      const count = await crew.resetAttendItems(resetMatch[1]!, Number(resetMatch[2]!));
      return json({ ok: true, reset: count });
    }
    if (p === "/api/pulls" && m === "GET") return json(await crew.pulls());
    const pullMatch = /^\/api\/pulls\/([a-z0-9._-]+)\/([0-9]+)\/(attend|retry|dismiss)$/.exec(p);
    if (pullMatch && m === "POST") {
      const [, repo, n, action] = pullMatch as unknown as [string, string, string, string];
      const number = Number(n);
      if (action === "attend") {
        const r = await crew.attendNow(repo, number);
        return "error" in r ? json(r, r.error === "not-found" ? 404 : 409) : json(r);
      }
      const { key } = await body();
      if (typeof key !== "string" || !key || key.length > 300) return json({ error: "bad-key" }, 400);
      const ok = action === "retry" ? crew.retryAttendItem(repo, number, key) : crew.dismissAttendItem(repo, number, key);
      return ok ? json({ ok: true }) : json({ error: "not-found" }, 404);
    }
    if (p === "/api/history" && m === "GET") return json(crew.history(Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 50))));
    if (p === "/api/harnesses" && m === "GET") return json(await crew.harnesses());
    const proveMatch = /^\/api\/harnesses\/([a-z0-9][a-z0-9-]*)\/prove$/.exec(p);
    if (proveMatch && m === "POST") {
      const r = await crew.prove(proveMatch[1]!);
      return "error" in r ? json(r, r.error === "busy" ? 409 : 400) : json(r);
    }
    if (p === "/api/settings" && m === "GET") return json(crew.settings());
    if (p === "/api/settings" && m === "PATCH") {
      const b = await body();
      const r = await crew.updateSettings({ values: b.values && typeof b.values === "object" ? b.values : undefined, autostart: b.autostart });
      return "error" in r ? json(r, r.error === "not-desktop" ? 409 : 400) : json(r);
    }
    if (p === "/api/team" && m === "GET") return json(crew.team());
    // Crew mode tasks: list, one with its ledger, a new one, and your approvals.
    if (p === "/api/tasks" && m === "GET") return json(await crew.tasks());
    if (p === "/api/tasks" && m === "POST") {
      const b = await body();
      const pickOne = <T extends string>(v: unknown, list: readonly T[]) => (list.includes(v as T) ? (v as T) : undefined);
      const r = await crew.newTask(String(b.repo ?? ""), typeof b.text === "string" ? b.text.slice(0, 4000) : "", {
        mode: pickOne(b.mode, ["inbox", "auto"] as const),
        as: pickOne(b.as, ["you", "crew"] as const),
        base: typeof b.base === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(b.base) ? b.base : undefined,
      });
      return "error" in r ? json(r, r.error === "not-found" ? 404 : 400) : json(r);
    }
    const taskMatch = /^\/api\/tasks\/([a-z0-9][a-z0-9-]{0,80})(?:\/(approve|cancel|run))?$/.exec(p);
    if (taskMatch && !taskMatch[2] && m === "GET") {
      const t = await crew.task(taskMatch[1]!);
      return t ? json(t) : json({ error: "not-found" }, 404);
    }
    if (taskMatch?.[2] && m === "POST") {
      const t = await crew.taskAction(taskMatch[1]!, taskMatch[2] as "approve" | "cancel" | "run");
      return t ? json(t) : json({ error: "not-found" }, 404);
    }
    if (p === "/api/limits" && m === "GET") return json({ ...crew.limits(), usageToday: await crew.usageToday() });
    return json({ error: "not-found" }, 404);
  }

  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: o.port ?? 0,
    // Some answers ask the git hosts first (who you are on each, a group's 30 repositories): a company GitLab can take
    // longer than Bun's 10-second default, which cut the request and left the page waiting.
    idleTimeout: 120,
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
