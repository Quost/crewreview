import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, RunRequest, RunResult } from "@crewreview/harness";
import { repoRef, type HostAdapter, type OpenPullRequestInput } from "@crewreview/hosts";
import { createTranslator } from "@crewreview/i18n";
import {
  appDirs,
  approveTask,
  createTask,
  git,
  newRepoEntry,
  parseConfig,
  QuotaBook,
  runTask,
  SeatBook,
  Store,
  type ConformanceStore,
  type LinkedRepo,
  type TaskDeps,
  type TaskEvent,
} from "../src/index.ts";

let root: string;
let remote: string;

async function sh(args: string[], cwd: string) {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewreview-tasks-"));
  remote = join(root, "remote.git");
  const work = join(root, "seed");
  await sh(["init", "-q", "--bare", "-b", "main", remote], root);
  await sh(["init", "-q", "-b", "main", work], root);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await sh(["config", k!, v!], work);
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, "src", "cart.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n");
  await sh(["add", "."], work);
  await sh(["commit", "-qm", "base"], work);
  await sh(["remote", "add", "origin", remote], work);
  await sh(["push", "-q", "origin", "main"], work);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

class Host implements Partial<HostAdapter> {
  opened: OpenPullRequestInput[] = [];
  constructor(readonly repo: ReturnType<typeof repoRef>) {}
  async whoami() {
    return "quost";
  }
  async defaultBranch() {
    return "main";
  }
  async openPullRequest(input: OpenPullRequestInput) {
    this.opened.push(input);
    return { number: 41, url: "https://example.test/acme/shop/pull/41" };
  }
}

const PLAN = {
  title: "Add discount codes to the cart",
  summary: "Add a discount helper and use it in the cart total.",
  steps: [
    { id: "helper", title: "Discount helper", detail: "A pure function: total minus total times pct.", files: ["src/discount.ts"], check: "rm -rf /" },
    { id: "use", title: "Apply it in the total", files: ["src/cart.ts"] },
  ],
  risks: ["Rounding"],
};

/** A scripted agent: plans, builds each step by writing files, reviews with no findings. Never calls a model. */
function agent(id: string, opts: { quotaOnFirstBuild?: boolean } = {}): Harness & { asked: { role: string; model?: string }[] } {
  const asked: { role: string; model?: string }[] = [];
  let builds = 0;
  return {
    id,
    name: id,
    kind: "native",
    capabilities: { readOnly: "enforced", write: true, streaming: false, costReport: false, modelSelect: true },
    asked,
    async detect() {
      return { installed: true, version: "1" };
    },
    async run(req: RunRequest): Promise<RunResult> {
      const ok = (text: string): RunResult => ({ ok: true, text, exitCode: 0, durationMs: 1 });
      if (req.prompt.includes("You are the planner")) {
        asked.push({ role: "plan", model: req.model });
        expect(req.access).toBe("read");
        return ok(JSON.stringify(PLAN));
      }
      if (req.prompt.includes("You are a builder")) {
        asked.push({ role: "build", model: req.model });
        expect(req.access).toBe("write");
        if (opts.quotaOnFirstBuild && builds++ === 0) {
          await writeFile(join(req.cwd, "src", "discount.ts"), "export const discount = (t: number) =>");
          return { ok: false, text: "", exitCode: 1, durationMs: 1, failure: "quota", error: "5-hour limit reached ∙ resets 3pm" };
        }
        const plan = await readFile(join(req.cwd, ".crewreview-attend", "plan.md"), "utf8");
        if (req.prompt.includes("Your step: helper")) {
          expect(plan).toMatch(/\[[ ~]\] \*\*helper\*\*/);
          await writeFile(join(req.cwd, "src", "discount.ts"), "export const discount = (t: number, pct: number) => t - t * pct;\n");
          return ok(JSON.stringify({ done: ["helper"], next: "use it in cart.ts", blockers: [], notes: "pure function" }));
        }
        if (req.prompt.includes("Your step: use")) {
          expect(await readFile(join(req.cwd, ".crewreview-attend", "handoff.md"), "utf8")).toContain("use it in cart.ts");
          await writeFile(join(req.cwd, "src", "cart.ts"), 'import { discount } from "./discount";\nexport const total = (xs: number[], pct = 0) => discount(xs.reduce((a, b) => a + b, 0), pct);\n');
          return ok(JSON.stringify({ done: ["use"], next: "", blockers: [], notes: "" }));
        }
        return ok(JSON.stringify({ done: [], next: "", blockers: ["?"], notes: "" }));
      }
      asked.push({ role: "review" });
      if (req.prompt.includes("You are the verifier")) return ok(JSON.stringify({ decisions: [] }));
      return ok(JSON.stringify({ findings: [] }));
    },
  };
}

const proven = { get: async () => ({ readOnly: "pass", writeScope: "pass", structured: "pass", at: "" }) } as unknown as ConformanceStore;

async function setup(config: object, harnesses: Harness[]) {
  const home = await mkdtemp(join(root, "home-"));
  const dirs = appDirs({ CREWREVIEW_HOME: home });
  const ref = { ...repoRef("github", "example.test", "acme/shop"), cloneUrl: remote };
  const repo: LinkedRepo = { ...newRepoEntry(ref, { attend: { validate: ["test -f src/discount.ts"] } }), ref };
  const cfg = parseConfig({ review: { lenses: ["correctness"] }, ...config });
  const registry = new Map(harnesses.map((h) => [h.id, h]));
  const quota = new QuotaBook(join(home, "quota.json"));
  const events: TaskEvent[] = [];
  const d: TaskDeps = {
    dirs,
    config: cfg,
    store: new Store(":memory:"),
    conformance: proven,
    registry,
    version: "test",
    ui: createTranslator("en"),
    quota,
    seats: new SeatBook(cfg, registry, proven, quota),
    signing: "off",
    identity: { name: "Crew Test", email: "crew@example.test" },
    onTask: (e) => events.push(e),
  };
  const host = new Host(ref);
  return { d, x: { repo, host: host as unknown as HostAdapter, token: "t" }, host, events, quota };
}

describe("crew mode tasks", () => {
  test("plan → your approval → each step built and committed → self-review → your approval → pull request", async () => {
    const h = agent("claude");
    const { d, x, host, events } = await setup({}, [h]);
    const t = await createTask(d, x, "Add discount codes to the cart total");
    expect(t).toMatchObject({ stage: "planning", base: "main", branch: `crew/${t.id}`, mode: "inbox" });

    // The plan waits for you.
    let rec = await runTask(d, x, t.id);
    expect(rec).toMatchObject({ stage: "approval", plan: { steps: [{ id: "helper", status: "todo" }, { id: "use", status: "todo" }] } });
    expect(await readFile(join(d.dirs.data, "tasks", t.id, "plan.md"), "utf8")).toContain("- [ ] **helper**: Discount helper");

    // Approved: both steps are built, checked with the project's own command (never the plan's), committed, reviewed.
    await approveTask(d, t.id);
    rec = await runTask(d, x, t.id);
    expect(rec).toMatchObject({ stage: "ready", lastReview: { findings: 0, blocking: 0 } });
    expect(rec!.plan!.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(events.filter((e) => e.type === "step-done").map((e) => (e as { step: string }).step)).toEqual(["helper", "use"]);
    expect(existsSync("/")).toBe(true); // the plan's "check" was never run

    // Opening the pull request waits for you too; then the branch is pushed with your token and opened.
    await approveTask(d, t.id);
    rec = await runTask(d, x, t.id);
    expect(rec).toMatchObject({ stage: "done", pr: { number: 41 } });
    expect(host.opened[0]).toMatchObject({ head: `crew/${t.id}`, base: "main", title: "Add discount codes to the cart" });
    expect(host.opened[0]!.body).toContain("- [x] Discount helper");
    const log = await sh(["log", "--format=%s|%an", `main..refs/heads/crew/${t.id}`], remote);
    expect(log.split("\n")).toEqual(["Apply it in the total|Crew Test", "Discount helper|Crew Test"]);
    // The step's detail is the commit's body, with the task and who built it.
    const body = await sh(["log", "-1", "--format=%b", `refs/heads/crew/${t.id}~1`], remote);
    expect(body).toContain("A pure function: total minus total times pct.");
    expect(body).toContain("Assisted-by: Crewreview test (claude)");
    expect(h.asked.map((a) => a.role)).toEqual(["plan", "build", "build", "review"]);
  }, 60_000);

  test("as the crew's account: its name on the commits, its host opens the pull request, so you can approve it", async () => {
    const { d, x } = await setup({}, [agent("claude")]);
    const bot = new Host(x.repo.ref);
    const tokens: string[] = [];
    const repo = { ...x.repo, review: { ...x.repo.review, account: "env:CREW_TOKEN" } };
    const crewDeps = { ...d, crewAccount: async () => (tokens.push("crew"), { token: "crew-token", host: bot as unknown as HostAdapter, identity: { name: "acme-crew", email: "crew@acme.test" } }) };
    const target = { ...x, repo };
    const t = await createTask(crewDeps, target, "Add discount codes", { mode: "auto" });
    expect(t.as).toBe("crew"); // a repository with a review account gets the crew by default
    const rec = await runTask(crewDeps, target, t.id);
    expect(rec).toMatchObject({ stage: "done", pr: { number: 41 } });
    expect(bot.opened).toHaveLength(1);
    expect((x.host as unknown as Host).opened).toHaveLength(0);
    const authors = await sh(["log", "--format=%an <%ae>", `main..refs/heads/crew/${t.id}`], remote);
    expect([...new Set(authors.split("\n"))]).toEqual(["acme-crew <crew@acme.test>"]);
  }, 60_000);

  test("a seat that hits its limit mid-step leaves a handoff code wrote; the next seat finishes the step", async () => {
    const a = agent("claude", { quotaOnFirstBuild: true });
    const b = agent("codex");
    const config = {
      seats: { opus: { harness: "claude", model: "claude-opus-5-5" }, fast: { harness: "codex", model: "gpt-6.1-sol" } },
      roles: { plan: ["opus"], build: ["opus", "fast"], review: ["fast"] },
      task: { maxReviewRounds: 1 },
    };
    const { d, x, quota } = await setup(config, [a, b]);
    const t = await createTask(d, x, "Add a discount helper", { mode: "auto" });
    const rec = await runTask(d, x, t.id);
    expect(rec).toMatchObject({ stage: "done", pr: { number: 41 } });
    const cut = rec!.handoffs.find((h) => h.cut);
    expect(cut).toMatchObject({ seat: "opus", cut: "quota", files: ["src/discount.ts"] });
    expect(quota.seatPausedUntil("opus")).toBeGreaterThan(Date.now());
    // The handoff code wrote is in the ledger, saying it wasn't the agent's own.
    const files = await import("node:fs/promises").then((fs) => fs.readdir(join(d.dirs.data, "tasks", t.id, "handoffs")));
    const cutFile = files.find((f) => f.includes("build-opus"))!;
    expect(await readFile(join(d.dirs.data, "tasks", t.id, "handoffs", cutFile), "utf8")).toContain("Written by Crewreview");
    expect(b.asked.filter((x) => x.role === "build").map((x) => x.model)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
  }, 60_000);
});
