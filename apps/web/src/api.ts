// Talks to the local daemon. The token arrives once in the URL fragment and stays in this tab only.

const KEY = "crewreview.token";

export function takeToken(): string | null {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem(KEY, m[1]!);
    history.replaceState(null, "", location.pathname + location.search + location.hash.replace(/(^#|&)token=[A-Za-z0-9_-]+/, "").replace(/^#$/, ""));
  }
  return sessionStorage.getItem(KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(typeof body?.error === "string" ? body.error : `HTTP ${status}`);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${sessionStorage.getItem(KEY) ?? ""}`, "x-crewreview": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** The request never reached the daemon: it stopped, or the page outlived it. */
export const unreachable = (err: unknown) => err instanceof TypeError;

export const api = {
  get: <T,>(path: string) => call<T>("GET", path),
  post: <T,>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  patch: <T,>(path: string, body: unknown) => call<T>("PATCH", path, body),
  del: <T,>(path: string) => call<T>("DELETE", path),
};

export function connectEvents(onMessage: (data: any) => void, onState: (open: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let stopped = false;
  let delay = 1000;
  const open = () => {
    // A reconnect scheduled before stop() must not open a second connection.
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/events?token=${encodeURIComponent(sessionStorage.getItem(KEY) ?? "")}`);
    ws.onopen = () => {
      delay = 1000;
      onState(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      onState(false);
      if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 15000)));
    };
  };
  open();
  return () => {
    stopped = true;
    ws?.close();
  };
}

// ---- shapes sent by the daemon ----

export type Severity = "blocker" | "major" | "minor" | "nit";

export interface Status {
  version: string;
  pid: number;
  startedAt: number;
  cycleRunning: boolean;
  lastCycleAt?: number;
  nextCycleAt?: number;
  inbox: number;
}

export interface LiveAgent {
  id: string;
  job: { repo: string; number: number; title: string; kind: "review" | "attend" };
  role: string;
  harness: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "ok" | "failed";
  lastTool?: string;
  tools: number;
  detail?: string;
}

export interface LogEntry {
  at: number;
  event: any;
}

export interface Repo {
  id: string;
  url: string;
  webUrl: string;
  kind: "github" | "gitlab";
  host: string;
  /** `org`: every repository of a GitHub organization or GitLab group. */
  scope?: "repo" | "org";
  include?: string[];
  exclude?: string[];
  /** Linked but left alone: no reviews or answers until resumed. */
  paused?: boolean;
  /** `account`: reviews post as this account (a gh login, or env:VARIABLE) instead of you. */
  review: { mode: "off" | "inbox" | "auto"; authors: "others" | "all" | "mine"; account?: string };
  attend: { mode: "off" | "inbox" | "auto"; fromCrew: boolean; maxPolishRounds: number; validate: string[]; conflicts: boolean; ci: boolean };
}

export interface Preview {
  link: string;
  org: boolean;
  repos: number;
  repoNames: string[];
  /** For an organization or group: every repository in it, subgroups included. */
  totalRepos?: number;
  pullRequests: number;
  wouldReview: { repo: string; number: number; title: string; url: string }[];
  skipped: Record<string, number>;
  perCycle: number;
  agentRuns: number;
  ownOpen: number;
  budget?: { used: number; limit: number };
  errors: { repo: string; error: string }[];
}

/** Whether Crewreview can reach a git host from this machine, and as whom. */
export interface HostAccess {
  kind: "github" | "gitlab";
  host: string;
  source?: "env" | "gh" | "glab";
  user?: string;
  error?: string;
}

export interface InboxItem {
  id: string;
  kind: "review" | "fix";
  repo: string;
  number: number;
  title: string;
  url: string;
  createdAt: number;
  event?: string;
  findings?: number;
  fixed?: number;
  replies?: number;
  forced?: string;
}

export interface Finding {
  id: string;
  lens: string;
  lenses: string[];
  path: string;
  line: number;
  endLine?: number;
  severity: Severity;
  title: string;
  body: string;
  confidence: string;
  verification?: { action: string; reason: string; from?: Severity };
}

export interface ReviewReport {
  target: { branch: string; base: string; headSha: string };
  files: { path: string }[];
  changedLines: number;
  lenses: { lens: string; harness: string; status: string; findings: unknown[]; durationMs: number; error?: string }[];
  findings: Finding[];
  repeated?: Finding[];
  verifier: { ran: boolean; harness?: string; ok?: boolean; dropped: unknown[]; downgraded: number };
  verdict: { event: string; reasons: string[]; counts: Record<Severity, number> };
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export interface AttendPayload {
  items: { key: string; kind: string; path?: string; line?: number; author: string; text: string; fromCrew: boolean }[];
  decisions: { key: string; action: "fixed" | "replied" | "declined" | "needs-human"; reply: string }[];
  summary: string;
  changed: string[];
  sensitive: string[];
  validation: { command: string; ok: boolean; output: string }[];
  harness: string;
  forcedInbox?: string;
}

export type InboxDetail = { kind: "review"; row: any; report: ReviewReport } | { kind: "fix"; row: any; payload: AttendPayload; diff: string };

export interface HistoryRow {
  id: string;
  kind: "review" | "fix";
  repo: string;
  number: number;
  title: string;
  url: string;
  status: string;
  event?: string | null;
  findings?: number;
  commit?: string | null;
  note?: string | null;
  error?: string | null;
  at: number;
}

export interface HarnessInfo {
  id: string;
  name: string;
  kind: string;
  installed: boolean;
  version?: string;
  capabilities: { readOnly: string; write: boolean; costReport: boolean };
  conformance?: { readOnly: string; writeScope?: string; structured: string; at: string };
  signIn?: { state: "yes" | "no" | "unknown"; reason?: string; expiresAt?: string };
  loginCommand?: string;
  /** Paused at its usage limit until then. */
  pausedUntil?: number;
  /** The one reviews use: the configured harness, or with \`auto\` the first installed one. */
  chosen?: boolean;
  /** Whether it may review now, or first proves its read-only lock here (ACP and custom agents). */
  review?: "ok" | "not-read-only" | "needs-conformance" | "failed-conformance";
  /** The proof runs right now. */
  proving?: boolean;
}

export interface Limits {
  limits: { maxConcurrentAgents?: number; agentTimeout: number; stallTimeout: number; maxDiffLines: number; dailyRuns?: number };
  schedule: { interval: number; offHoursInterval: number; peakHours: string; maxReviewsPerCycle: number };
  review: { settle: number; ciMaxWait: number; maxFailures: number; lenses: string[]; policy: { allowApprove: boolean; requestChangesAt: string } };
  attend: { quiet: number; validateTimeout: number; maxPerCycle: number };
  harness: { default: string; verifier?: string; fallback?: string[] };
  quota?: { runsToday: number; paused: { harness: string; until: number; reason: string }[] };
  usageToday: { reviews: number; inputTokens: number; outputTokens: number; costUsd: number };
  configPath?: string;
}
