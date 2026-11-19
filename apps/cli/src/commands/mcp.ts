import { createInterface } from "node:readline";
import { ConformanceStore, configFile, CrewDaemon, readApiInfo, registryFor, reposFile, REVIEW_MODES, type ReviewReport } from "@crewreview/engine";
import { openStore, type Ctx } from "../ctx.ts";
import { localReview } from "./local.ts";

/**
 * `crewreview mcp`: a Model Context Protocol server over stdio, so coding agents (Claude Code, Codex, Kiro, Gemini
 * CLI, OpenCode…) can find Crewreview, set it up and use it. It never posts, pushes or approves: those stay with
 * you, in the dashboard or the CLI.
 */

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, any>): Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const modes = (description: string) => ({ type: "string", enum: [...REVIEW_MODES], description });

function summarize(r: ReviewReport) {
  return {
    verdict: r.verdict.event,
    reasons: r.verdict.reasons,
    counts: r.verdict.counts,
    branch: r.target.branch,
    base: r.target.base,
    lenses: r.lenses.map((l) => ({ lens: l.lens, harness: l.harness, status: l.status, findings: l.findings.length, error: l.error })),
    findings: r.findings.map((f) => ({ severity: f.severity, file: f.path, line: f.line, title: f.title, body: f.body, lenses: f.lenses, suggestion: f.suggestion })),
    usage: r.usage,
  };
}

export function mcpTools(c: Ctx, crew: CrewDaemon): Tool[] {
  return [
    {
      name: "crewreview_status",
      description: "Is the Crewreview daemon running, which repositories it watches, and how many reviews or answers wait for approval.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const api = await readApiInfo(c.dirs.state);
        const repos = await crew.repos();
        return {
          version: c.version,
          daemon: api ? { running: true, dashboard: api.url, pid: api.pid } : { running: false, hint: "Start it with `crewreview run`, or install it with `crewreview service install`." },
          repositories: repos.map((r) => ({ id: r.id, url: r.ref.webUrl, review: r.review.mode, authors: r.review.authors, attendant: r.attend.mode, polish: r.attend.fromCrew })),
          inbox: crew.inbox().length,
        };
      },
    },
    {
      name: "crewreview_review_local",
      description:
        "Review the current branch of a local git repository against its base with Crewreview's lenses and verifier, before committing or opening a pull request. Nothing is posted. Takes a few minutes; returns the verdict and findings with file and line.",
      inputSchema: {
        type: "object",
        properties: {
          path: str("Folder inside the git repository (default: the server's working directory)."),
          base: str("Base ref to compare with, e.g. origin/main (default: detected)."),
          uncommitted: { type: "boolean", description: "Also review uncommitted changes to tracked files." },
          lenses: str("Comma-separated lenses, e.g. correctness,security (default: all that apply)."),
          harness: str("Harness for the lenses: auto, claude, codex, kiro or one from the config."),
          language: str("Language for the findings, e.g. en, pt-BR."),
        },
      },
      async run(a) {
        const r = await localReview(c, { cwd: a.path, base: a.base, uncommitted: Boolean(a.uncommitted), harness: a.harness, lens: a.lenses, lang: a.language, verify: true, json: true });
        if ("error" in r) throw new Error(r.error);
        return { ...summarize(r.report), report: r.reportPath };
      },
    },
    {
      name: "crewreview_inbox",
      description: "Reviews and answers waiting for the user's approval. Show one with crewreview_inbox_item. Approving is the user's call: tell them to use the dashboard (`crewreview ui`) or `crewreview inbox approve <id>`.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return crew.inbox();
      },
    },
    {
      name: "crewreview_inbox_item",
      description: "One inbox item: a review's verdict and findings, or an answer's decisions, replies and diff.",
      inputSchema: { type: "object", properties: { id: str("Item id from crewreview_inbox, like r12 or f3.") }, required: ["id"] },
      async run(a) {
        const item = await crew.inboxItem(String(a.id));
        if (!item) throw new Error(`no inbox item ${a.id}`);
        return item.kind === "review" ? { kind: "review", ...summarize(item.report) } : { kind: "answer", decisions: item.payload.decisions, changed: item.payload.changed, checks: item.payload.validation, diff: item.diff.slice(0, 20_000) };
      },
    },
    {
      name: "crewreview_repo_link",
      description: "Link a GitHub or GitLab repository so the daemon watches it. Only do this when the user asked. Uses the gh/glab login already on this machine. New repositories review in inbox mode (nothing is posted without approval).",
      inputSchema: {
        type: "object",
        properties: { url: str("Repository URL, e.g. https://github.com/owner/repo."), review: modes("Review mode (default inbox).") },
        required: ["url"],
      },
      async run(a) {
        const r = await crew.addRepo(String(a.url), REVIEW_MODES.includes(a.review) ? a.review : "inbox");
        if ("error" in r) throw new Error(r.message ? `${r.error}: ${r.message}` : r.error);
        return { linked: r.repo.id, as: r.user, review: r.repo.review.mode };
      },
    },
    {
      name: "crewreview_repo_set",
      description: "Change what the crew does on a linked repository. Only when the user asked. review: off|inbox|auto for other people's pull requests; attendant: off|inbox|auto for answering reviews on the user's own; polish: also fix the crew's own findings.",
      inputSchema: {
        type: "object",
        properties: {
          id: str("Repository id from crewreview_status."),
          review: modes("Review mode."),
          attendant: modes("Attendant mode."),
          authors: { type: "string", enum: ["others", "all", "mine"], description: "Whose pull requests to review." },
          polish: { type: "boolean", description: "Polish loop on or off." },
        },
        required: ["id"],
      },
      async run(a) {
        const review: Record<string, string> = {};
        const attend: Record<string, unknown> = {};
        if (REVIEW_MODES.includes(a.review)) review.mode = a.review;
        if (["others", "all", "mine"].includes(a.authors)) review.authors = a.authors;
        if (REVIEW_MODES.includes(a.attendant)) attend.mode = a.attendant;
        if (typeof a.polish === "boolean") attend.fromCrew = a.polish;
        const r = await crew.updateRepo(String(a.id), { review, attend } as never);
        if (!r) throw new Error(`no linked repository ${a.id}`);
        return { id: r.id, review: r.review.mode, authors: r.review.authors, attendant: r.attend.mode, polish: r.attend.fromCrew };
      },
    },
    {
      name: "crewreview_harnesses",
      description: "Which coding-agent harnesses are installed, and whether their read-only and write-scope locks were proven on this machine (`crewreview doctor --conformance`).",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return crew.harnesses();
      },
    },
    {
      name: "crewreview_config",
      description: "Where Crewreview's settings live and what they are now, to help the user change them. Edit the TOML files; the daemon reads them at start.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        return {
          config: configFile(c.dirs),
          repositories: reposFile(c.dirs),
          data: c.dirs.data,
          current: { harness: c.config.harness, limits: c.config.limits, schedule: c.config.schedule, review: c.config.review, attend: c.config.attend, updates: c.config.updates, language: c.config.language },
          docs: "https://github.com/Quost/crewreview#configuration",
        };
      },
    },
  ];
}

type Message = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any };

export async function mcp(c: Ctx): Promise<number> {
  const store = openStore(c);
  const crew = new CrewDaemon({ dirs: c.dirs, config: c.config, version: c.version, ui: c.t, store, conformance: ConformanceStore.in(c.dirs.state), registry: registryFor(c.config), configPath: c.configPath });
  const tools = mcpTools(c, crew);
  const send = (m: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const reply = (id: Message["id"], result: unknown) => send({ id, result });
  const fail = (id: Message["id"], code: number, message: string) => send({ id, error: { code, message } });

  const handle = async (m: Message) => {
    if (m.id === undefined) return; // notifications (initialized, cancelled): nothing to answer
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        return reply(m.id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "crewreview", version: c.version },
          instructions:
            "Crewreview reviews pull requests with a crew of read-only AI lenses and answers the reviews on the user's own pull requests. Use crewreview_review_local to check a branch before committing; crewreview_status to see what it watches. Never approve or post on the user's behalf: point them to `crewreview ui`.",
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        return reply(m.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = tools.find((t) => t.name === m.params?.name);
        if (!tool) return fail(m.id, -32602, `unknown tool ${m.params?.name}`);
        try {
          const result = await tool.run(m.params?.arguments ?? {});
          return reply(m.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          return reply(m.id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
        }
      }
      default:
        return fail(m.id, -32601, `method not found: ${m.method}`);
    }
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<unknown>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let m: Message;
    try {
      m = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    // Requests run concurrently: a long review doesn't block a status call.
    const p = handle(m).catch((e) => fail(m.id, -32603, e instanceof Error ? e.message : String(e)));
    pending.add(p);
    p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
  store.close();
  return 0;
}

/** How to add the server to each harness. */
export function mcpSetup(c: Ctx): number {
  const exe = /(^|[\\/])bun(\.exe)?$/i.test(process.execPath) ? `${process.execPath} ${process.argv[1]}` : process.execPath;
  const [cmd, ...rest] = exe.split(" ");
  const args = [...rest, "mcp"];
  const json = JSON.stringify({ mcpServers: { crewreview: { command: cmd, args } } }, null, 2);
  c.out(
    [
      "# Claude Code",
      `claude mcp add --scope user crewreview -- ${exe} mcp`,
      "",
      "# Codex CLI (~/.codex/config.toml)",
      `[mcp_servers.crewreview]\ncommand = ${JSON.stringify(cmd)}\nargs = ${JSON.stringify(args)}`,
      "",
      "# Gemini CLI (~/.gemini/settings.json), Kiro (~/.kiro/settings/mcp.json), Cursor (~/.cursor/mcp.json)",
      json,
      "",
      "# OpenCode (opencode.json)",
      JSON.stringify({ mcp: { crewreview: { type: "local", command: [cmd, ...args] } } }, null, 2),
    ].join("\n"),
  );
  return 0;
}
