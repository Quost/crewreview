export interface HttpResponse {
  status: number;
  headers: Headers;
  data: any;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** One HTTP call. `path` is relative to the API base, or an absolute URL (pagination links). */
export interface Transport {
  request(method: string, path: string, options?: RequestOptions): Promise<HttpResponse>;
}

export type HostErrorKind = "auth" | "not-found" | "rate-limit" | "invalid" | "server" | "network";

export class HostError extends Error {
  constructor(
    readonly kind: HostErrorKind,
    readonly status: number,
    message: string,
    /** For rate limits: when to try again (ms since epoch). */
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

function kindOf(status: number, headers: Headers): HostErrorKind {
  if (status === 401) return "auth";
  if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) return "rate-limit";
  if (status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  return "invalid";
}

function buildUrl(base: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(/^https?:\/\//.test(path) ? path : `${base.replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

export interface HttpTransportOptions {
  baseUrl: string;
  /** Builds the auth header from the token. */
  auth: (token: string) => Record<string, string>;
  token?: string;
  userAgent?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Talks to a host's REST/GraphQL API. The token stays in this process; it's never passed to an agent. */
export function httpTransport(o: HttpTransportOptions): Transport {
  const doFetch = o.fetch ?? fetch;
  return {
    async request(method, path, options = {}) {
      const headers: Record<string, string> = {
        accept: "application/json",
        "user-agent": o.userAgent ?? "crewreview",
        ...(o.token ? o.auth(o.token) : {}),
      };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await doFetch(buildUrl(o.baseUrl, path, options.query), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
        });
      } catch (e) {
        throw new HostError("network", 0, e instanceof Error ? e.message : String(e));
      }
      const text = await res.text();
      let data: any = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const msg = typeof data === "object" && data ? (data.message ?? data.error ?? JSON.stringify(data)) : String(data);
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset"));
        throw new HostError(kindOf(res.status, res.headers), res.status, `${method} ${path}: ${res.status} ${String(msg).slice(0, 300)}`, reset ? reset * 1000 : undefined);
      }
      return { status: res.status, headers: res.headers, data };
    },
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  query?: RequestOptions["query"];
  body?: unknown;
}

type Fixture = unknown | { status: number; data?: unknown; headers?: Record<string, string> };

/**
 * A transport that answers from a table, for contract tests without network. Keys are "METHOD path" and may end
 * with "?key=value" to match a query parameter. Every call is recorded.
 */
export function fixtureTransport(table: Record<string, Fixture>): Transport & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async request(method, path, options = {}) {
      calls.push({ method, path, query: options.query, body: options.body });
      const candidates = Object.keys(table).filter((k) => {
        const [m, rest] = [k.slice(0, k.indexOf(" ")), k.slice(k.indexOf(" ") + 1)];
        if (m !== method) return false;
        const [p, q] = rest.split("?");
        if (p !== path) return false;
        if (!q) return true;
        return q.split("&").every((kv) => {
          const [key, value] = kv.split("=");
          return String(options.query?.[key!] ?? "") === value;
        });
      });
      // The most specific key (with a query) wins.
      const key = candidates.sort((a, b) => b.length - a.length)[0];
      if (key === undefined) throw new HostError("not-found", 404, `no fixture for ${method} ${path}`);
      const f = table[key] as any;
      const isWrapped = f && typeof f === "object" && typeof f.status === "number" && ("data" in f || "headers" in f);
      const status = isWrapped ? f.status : 200;
      const headers = new Headers(isWrapped ? (f.headers ?? {}) : {});
      const data = isWrapped ? f.data : f;
      if (status >= 400) throw new HostError(kindOf(status, headers), status, `${method} ${path}: ${status}`);
      return { status, headers, data };
    },
  };
}

/** Follow pagination until `next` returns nothing or `max` items are collected. */
export async function paginate<T>(
  t: Transport,
  path: string,
  query: RequestOptions["query"],
  next: (res: HttpResponse) => { path: string; query?: RequestOptions["query"] } | undefined,
  max = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let req: { path: string; query?: RequestOptions["query"] } | undefined = { path, query };
  while (req && out.length < max) {
    const res = await t.request("GET", req.path, { query: req.query });
    if (!Array.isArray(res.data)) break;
    out.push(...(res.data as T[]));
    req = res.data.length === 0 ? undefined : next(res);
  }
  return out.slice(0, max);
}
