#!/usr/bin/env bun
// The real dashboard and API with made-up data: agents at work, an inbox, history, repositories and limits.
// For screenshots (scripts/screenshots.ts) and for working on the UI without a crew running.
//   bun scripts/demo-dashboard.ts [--port 4620] [--empty]
// --empty starts with nothing linked, as on a first run.
// It prints the dashboard's address. Nothing is read from or written to your Crewreview folder.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dashboard from "../apps/web/index.html";
import { dashboardUrl, startApi } from "../packages/engine/src/api.ts";
import type { CrewDaemon } from "../packages/engine/src/crew.ts";
import pkg from "../package.json";

const TOKEN = "demo";
const empty = process.argv.includes("--empty");
const now = Date.now();
const ago = (s: number) => now - s * 1000;

const SHOP = { repo: "acme/shop", number: 142, title: "Add discount codes to checkout", kind: "review" as const };
const API = { repo: "acme/api", number: 87, title: "Rate limit the public endpoints", kind: "attend" as const };

const agents = [
  { id: "a1", job: SHOP, role: "correctness", harness: "claude", startedAt: ago(48), status: "running", lastTool: "Read src/cart/discount.ts", tools: 14 },
  { id: "a2", job: SHOP, role: "security", harness: "codex", startedAt: ago(47), status: "running", lastTool: "rg \"req.query\" src/api", tools: 9 },
  { id: "a3", job: SHOP, role: "tests", harness: "claude", startedAt: ago(47), endedAt: ago(12), status: "ok", tools: 6, detail: "1" },
  { id: "a4", job: SHOP, role: "architecture", harness: "kiro", startedAt: ago(46), endedAt: ago(20), status: "ok", tools: 5, detail: "0" },
  { id: "a5", job: API, role: "attendant", harness: "codex", startedAt: ago(95), status: "running", lastTool: "Edit src/middleware/rate-limit.ts", tools: 21 },
];

const log = [
  { at: ago(1500), event: { type: "cycle", repos: 3, reviewed: 1, waiting: 0 } },
  { at: ago(1440), event: { type: "outcome", repo: "acme/web", number: 311, outcome: { kind: "posted", event: "approve" } } },
  { at: ago(900), event: { type: "attend-outcome", repo: "acme/api", number: 85, outcome: { kind: "done", replies: 3, resolved: 2 } } },
  { at: ago(620), event: { type: "skip", repo: "acme/web", number: 315, reason: "draft" } },
  { at: ago(400), event: { type: "outcome", repo: "acme/shop", number: 139, outcome: { kind: "pending", findings: 3 } } },
  { at: ago(240), event: { type: "attend-outcome", repo: "acme/api", number: 86, outcome: { kind: "pending", fixed: 2, replies: 2 } } },
  { at: ago(48), event: { type: "start", repo: "acme/shop", number: 142, title: SHOP.title } },
];

const inbox = [
  { id: "r12", kind: "review", repo: "acme/shop", number: 139, title: "Ship orders with the new carrier API", url: "https://github.com/acme/shop/pull/139", createdAt: ago(400), event: "request_changes", findings: 3 },
  { id: "f7", kind: "fix", repo: "acme/api", number: 86, title: "Paginate the audit log", url: "https://gitlab.com/acme/api/-/merge_requests/86", createdAt: ago(240), fixed: 2, replies: 1 },
];

const finding = (id: string, severity: string, lenses: string[], path: string, line: number, title: string, body: string) => ({ id, lens: lenses[0], lenses, path, line, severity, title, body, confidence: "high" });

const review = {
  kind: "review",
  row: inbox[0],
  report: {
    target: { branch: "feat/carrier-api", base: "main", headSha: "9f3c2ab" },
    files: [{ path: "src/shipping/carrier.ts" }, { path: "src/shipping/label.ts" }, { path: "test/shipping.test.ts" }],
    changedLines: 214,
    lenses: [],
    findings: [
      finding("x1", "blocker", ["security"], "src/shipping/carrier.ts", 58, "The carrier API key is logged on every failed request", "`logger.error(err.config)` writes the whole request config, headers included, so `Authorization: Bearer <key>` lands in the logs. Log `err.config.url` and the status instead."),
      finding("x2", "major", ["correctness", "tests"], "src/shipping/label.ts", 31, "Weights in grams are sent where the API expects kilograms", "`order.weight` is stored in grams (see `src/orders/model.ts:12`), and the carrier's `weight` field is in kg. A 2 kg box is labeled as 2000 kg. Divide by 1000 and add a test with a real order."),
      finding("x3", "minor", ["architecture"], "src/shipping/carrier.ts", 12, "A retry loop duplicates the HTTP client's own retries", "`httpClient` already retries 3 times with backoff (`src/lib/http.ts:40`). This loop multiplies it to 9 attempts per label."),
    ],
    verifier: { ran: true, harness: "codex", ok: true, dropped: [{}], downgraded: 1 },
    verdict: { event: "request_changes", reasons: ["blocking-findings"], counts: { blocker: 1, major: 1, minor: 1, nit: 0 } },
    usage: { inputTokens: 182_000, outputTokens: 9_400, costUsd: 0.61 },
  },
};

const fix = {
  kind: "fix",
  row: inbox[1],
  payload: {
    items: [
      { key: "t1", kind: "thread", path: "src/audit/list.ts", line: 22, author: "marina", text: "This loads the whole table into memory. Can we page it with a cursor?", fromCrew: false },
      { key: "t2", kind: "thread", path: "src/audit/list.ts", line: 40, author: "marina", text: "Missing a test for the last page.", fromCrew: false },
      { key: "t3", kind: "thread", path: "README.md", line: 88, author: "joao", text: "Should the default page size be configurable?", fromCrew: false },
    ],
    decisions: [
      { key: "t1", action: "fixed", reply: "Done: the list now pages with a cursor on (created_at, id), 50 rows by default, in 4e1d2c0." },
      { key: "t2", action: "fixed", reply: "Added `returns an empty last page` and `stops at the cursor` in test/audit.test.ts." },
      { key: "t3", action: "replied", reply: "It's read from AUDIT_PAGE_SIZE now, with 50 as the default. I documented it in the README." },
    ],
    summary: "Paged the audit log with a cursor and covered the last page with tests.",
    changed: ["src/audit/list.ts", "test/audit.test.ts", "README.md"],
    sensitive: [],
    validation: [{ command: "bun test", ok: true, output: "" }],
    harness: "codex",
  },
  diff: [
    "--- a/src/audit/list.ts",
    "+++ b/src/audit/list.ts",
    "@@ -18,9 +18,16 @@ export async function listAudit(db: Db, q: AuditQuery) {",
    "-  const rows = await db.select().from(audit).orderBy(desc(audit.createdAt));",
    "-  return rows.filter((r) => matches(r, q));",
    "+  const size = Number(process.env.AUDIT_PAGE_SIZE ?? 50);",
    "+  const rows = await db",
    "+    .select()",
    "+    .from(audit)",
    "+    .where(and(matchesSql(q), q.cursor ? before(q.cursor) : undefined))",
    "+    .orderBy(desc(audit.createdAt), desc(audit.id))",
    "+    .limit(size + 1);",
    "+  const page = rows.slice(0, size);",
    "+  return { rows: page, next: rows.length > size ? cursorOf(page.at(-1)!) : undefined };",
    " }",
  ].join("\n"),
};

const repos = [
  { id: "acme-shop", url: "https://github.com/acme/shop", kind: "github", webUrl: "https://github.com/acme/shop", host: "github.com", review: { mode: "inbox", authors: "others" }, attend: { mode: "inbox", fromCrew: true, maxPolishRounds: 2, validate: ["bun test"] } },
  { id: "acme-api", url: "https://gitlab.com/acme/api", kind: "gitlab", webUrl: "https://gitlab.com/acme/api", host: "gitlab.com", review: { mode: "auto", authors: "others" }, attend: { mode: "inbox", fromCrew: false, maxPolishRounds: 0, validate: ["npm test"] } },
  { id: "acme-web", url: "https://github.com/acme/web", kind: "github", webUrl: "https://github.com/acme/web", host: "github.com", review: { mode: "auto", authors: "all" }, attend: { mode: "off", fromCrew: false, maxPolishRounds: 0, validate: [] } },
  { id: "acme-platform", url: "https://gitlab.com/acme/platform", kind: "gitlab", scope: "org", webUrl: "https://gitlab.com/acme/platform", host: "gitlab.com", review: { mode: "inbox", authors: "others" }, attend: { mode: "off", fromCrew: false, maxPolishRounds: 0, validate: [] } },
];

const history = [
  { id: "r11", kind: "review", repo: "acme/web", number: 311, title: "Dark mode for the settings page", url: "", status: "posted", event: "approve", findings: 0, at: ago(1440) },
  { id: "f6", kind: "fix", repo: "acme/api", number: 85, title: "Validate webhook signatures", url: "", status: "done", commit: "b71e0d4", at: ago(900) },
  { id: "r10", kind: "review", repo: "acme/web", number: 315, title: "WIP: new onboarding", url: "", status: "skipped", note: "draft", at: ago(620) },
  { id: "r12", kind: "review", repo: "acme/shop", number: 139, title: "Ship orders with the new carrier API", url: "", status: "pending", event: "request_changes", findings: 3, at: ago(400) },
  { id: "f7", kind: "fix", repo: "acme/api", number: 86, title: "Paginate the audit log", url: "", status: "pending", at: ago(240) },
  { id: "r9", kind: "review", repo: "acme/shop", number: 137, title: "Cache product images at the edge", url: "", status: "posted", event: "comment", findings: 2, at: ago(7200) },
  { id: "r8", kind: "review", repo: "acme/api", number: 84, title: "Move sessions to Redis", url: "", status: "posted", event: "request_changes", findings: 4, at: ago(10800) },
  { id: "f5", kind: "fix", repo: "acme/shop", number: 136, title: "Fix rounding in tax totals", url: "", status: "done", commit: "e02a9f1", at: ago(14400) },
].sort((a, b) => b.at - a.at);

const harnesses = [
  { id: "claude", name: "Claude Code", kind: "claude", installed: true, version: "2.6.1", capabilities: { readOnly: "enforced", write: true, costReport: true }, conformance: { readOnly: "pass", writeScope: "pass", structured: "pass", at: new Date(ago(86400)).toISOString() }, signIn: { state: "yes", expiresAt: new Date(now + 6 * 86_400_000).toISOString() }, loginCommand: "claude auth login", chosen: true },
  { id: "codex", name: "Codex CLI", kind: "codex", installed: true, version: "0.98.0", capabilities: { readOnly: "enforced", write: true, costReport: true }, conformance: { readOnly: "pass", writeScope: "pass", structured: "pass", at: new Date(ago(86400)).toISOString() }, signIn: { state: "yes" }, loginCommand: "codex login" },
  { id: "kiro", name: "Kiro CLI", kind: "kiro", installed: true, version: "1.24.0", capabilities: { readOnly: "enforced", write: true, costReport: false }, conformance: { readOnly: "pass", writeScope: "fail", structured: "pass", at: new Date(ago(86400)).toISOString() }, signIn: { state: "yes" }, loginCommand: "kiro-cli login" },
  { id: "gemini", name: "Gemini CLI (ACP)", kind: "acp", installed: false, capabilities: { readOnly: "enforced", write: true, costReport: false } },
];

const limits = {
  limits: { maxConcurrentAgents: 4, agentTimeout: 20 * 60_000, stallTimeout: 8 * 60_000, maxDiffLines: 4000 },
  schedule: { interval: 3 * 60_000, offHoursInterval: 20 * 60_000, peakHours: "8-19", maxReviewsPerCycle: 2 },
  review: { settle: 5 * 60_000, ciMaxWait: 30 * 60_000, maxFailures: 3, lenses: ["correctness", "security", "architecture", "tests", "ui"], policy: { allowApprove: true, requestChangesAt: "major" } },
  attend: { quiet: 45_000, validateTimeout: 10 * 60_000, maxPerCycle: 2 },
  harness: { default: "claude", verifier: "codex" },
  configPath: "~/.config/crewreview/config.toml",
};

const status = { version: pkg.version, pid: process.pid, startedAt: ago(7300), cycleRunning: false, lastCycleAt: ago(60), nextCycleAt: now + 240_000, inbox: inbox.length };

const crew = {
  o: { version: status.version },
  status: () => status,
  liveAgents: () => agents,
  recentLog: () => log,
  wake() {},
  repos: async () => (empty ? [] : repos).map((r) => ({ ...r, ref: { kind: r.kind, webUrl: r.webUrl, host: r.host } })),
  addRepo: async () => ({ error: "host", message: "this is a demo: nothing is linked" }),
  // The second-account page: "glpat-demo" belongs to a group bot that reaches the group but not acme/api.
  accountToken: async (ids: string[], token: string) =>
    token !== "glpat-demo" && token !== "ghp_demo"
      ? { error: "host", name: "", message: "401 Unauthorized" }
      : {
          user: token === "glpat-demo" ? "group_42_bot_7f3a" : "acme-crew",
          account: token === "glpat-demo" ? "keychain:gitlab.com/group_42_bot_7f3a" : "keychain:github.com/acme-crew",
          reach: ids.map((id) => ({ id, permission: id === "acme-api" ? "none" : "write" })),
          accepted: token === "ghp_demo" ? ids.filter((id) => id !== "acme-platform") : [],
          applied: ids.filter((id) => id !== "acme-api"),
        },
  signInStatus: () => ({ state: "idle" }),
  team: () => ({
    roles: [
      { role: "review", seats: ["fast", "sonnet"], balance: "spread", configured: true },
      { role: "verify", seats: ["opus"], balance: "order", configured: true },
      { role: "attend", seats: ["sonnet", "fast"], balance: "order", configured: true },
    ],
    seats: [
      { id: "fast", harness: "codex", model: "gpt-6.1-sol", effort: "low", dailyRuns: 40, named: true, runsToday: 18, roles: ["review", "attend"], working: [{ role: "security", repo: "acme/shop", number: 142 }, { role: "attendant", repo: "acme/api", number: 87 }] },
      { id: "sonnet", harness: "claude", model: "claude-sonnet-5-5", effort: "medium", named: true, runsToday: 11, roles: ["review", "attend"], working: [{ role: "correctness", repo: "acme/shop", number: 142 }] },
      { id: "opus", harness: "claude", model: "claude-opus-5-5", effort: "high", named: true, runsToday: 5, pausedUntil: now + 2 * 3_600_000, reason: "5-hour limit reached", roles: ["verify"], working: [] },
    ],
    configPath: "~/.config/crewreview/config.toml",
    auto: false,
  }),
  hosts: async () => [
    { kind: "github", host: "github.com", source: "gh", user: "ana" },
    { kind: "gitlab", host: "gitlab.com" },
  ],
  previewUrl: async (url: string) => ({ ...(await crew.previewRepo("acme-web")), link: url.replace(/^https?:\/\//, "") }),
  updateRepo: async () => true,
  removeRepo: async () => false,
  previewRepo: async (id: string) => ({
    link: id,
    org: false,
    repos: 1,
    pullRequests: 6,
    wouldReview: [
      { repo: "acme/web", number: 318, title: "Move the checkout button above the fold", url: "https://github.com/acme/web/pull/318" },
      { repo: "acme/web", number: 320, title: "Lazy-load the product gallery", url: "https://github.com/acme/web/pull/320" },
    ],
    skipped: { draft: 2, "bot-author": 1, "already-reviewed": 1 },
    perCycle: 2,
    agentRuns: 12,
    ownOpen: 1,
    budget: { used: 34, limit: 200 },
    errors: [],
  }),
  inbox: () => inbox,
  inboxItem: async (id: string) => (id === "r12" ? review : id === "f7" ? fix : undefined),
  approve: async () => ({ kind: "failed", error: "This is a demo: nothing is posted." }),
  discard: async () => false,
  history: (n: number) => history.slice(0, n),
  harnesses: async () => harnesses,
  limits: () => ({ ...limits, limits: { ...limits.limits, dailyRuns: 200 }, quota: { runsToday: 34, paused: [] } }),
  usageToday: async () => ({ reviews: 7, inputTokens: 1_240_000, outputTokens: 61_000, costUsd: 3.85 }),
  settings: () => ({
    values: {
      "schedule.interval": "3m",
      "schedule.offHoursInterval": "20m",
      "schedule.peakHours": "8-19",
      "schedule.maxReviewsPerCycle": 2,
      "schedule.keepAwake": true,
      "limits.maxConcurrentAgents": 4,
      "limits.agentTimeout": "20m",
      "limits.stallTimeout": "8m",
      "limits.maxDiffLines": 4000,
      "limits.dailyRuns": 200,
      "review.settle": "5m",
      "review.ciMaxWait": "30m",
      "review.policy.allowApprove": true,
      "attend.quiet": "45s",
      "attend.maxPerCycle": 2,
      "harness.default": "claude",
      "harness.verifier": "codex",
      "updates.check": true,
    },
    harnesses: ["auto", "claude", "codex", "kiro"],
    configPath: "~/.config/crewreview/config.toml",
    desktop: { autostart: true },
  }),
  updateSettings: async () => ({ error: "this is a demo: nothing is saved" }),
  subscribe: () => () => {},
} as unknown as CrewDaemon;

const portArg = process.argv.indexOf("--port");
const api = await startApi({ crew, page: dashboard, stateDir: await mkdtemp(join(tmpdir(), "crewreview-demo-")), token: TOKEN, port: portArg > 0 ? Number(process.argv[portArg + 1]) : 0 });
console.log(dashboardUrl(api));
