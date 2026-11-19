import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMarker, type PullRequest } from "@crewreview/core";
import type { Harness, RunResult } from "@crewreview/harness";
import { repoRef, type HostAdapter, type PostReviewInput, type RepoRef, type Thread } from "@crewreview/hosts";
import { createTranslator } from "@crewreview/i18n";
import {
  appDirs,
  ConformanceStore,
  git,
  loadRepos,
  newRepoEntry,
  nextInterval,
  parseConfig,
  postReview,
  reviewPullRequest,
  runCycle,
  saveRepos,
  serializeRepos,
  Store,
  type DaemonEvent,
  type LinkedRepo,
  type PrDeps,
  type PrTarget,
} from "../src/index.ts";

let root: string;
let remote: string;
let work: string;

async function sh(args: string[], cwd: string) {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A local bare repository plays the remote; refs/pull/N/head is created like GitHub does. */
async function pushPull(n: number, branch: string) {
  const sha = await sh(["rev-parse", branch], work);
  await sh(["push", "-q", "origin", `${branch}:refs/heads/${branch}`], work);
  await sh(["update-ref", `refs/pull/${n}/head`, sha], remote);
  return sha;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewreview-m2-"));
  remote = join(root, "remote.git");
  work = join(root, "work");
  await sh(["init", "-q", "--bare", "-b", "main", remote], root);
  await sh(["init", "-q", "-b", "main", work], root);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await sh(["config", k!, v!], work);
  await sh(["remote", "add", "origin", remote], work);
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src", "cart.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n");
  await sh(["add", "-A"], work);
  await sh(["commit", "-qm", "base"], work);
  await sh(["push", "-q", "origin", "main"], work);
  await sh(["checkout", "-qb", "discount"], work);
  await writeFile(join(work, "src", "cart.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport const discount = (t: number, pct: number) => t - t * pct;\n");
  await sh(["commit", "-qam", "add discount"], work);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

class FakeHost implements HostAdapter {
  posted: { pr: number; input: PostReviewInput }[] = [];
  threads: Thread[] = [];
  constructor(
    readonly repo: RepoRef,
    public prs: PullRequest[],
  ) {}
  async whoami() {
    return "quost";
  }
  async listOpenPullRequests() {
    return this.prs;
  }
  async getPullRequest(n: number) {
    return this.prs.find((p) => p.number === n)!;
  }
  async listThreads() {
    return this.threads;
  }
  async listReviews() {
    return [];
  }
  async getChecks() {
    return { state: "green" as const, failing: [] };
  }
  async postReview(pr: PullRequest, input: PostReviewInput) {
    this.posted.push({ pr: pr.number, input });
    // Like a real host: the summary and every inline comment become part of the discussion.
    const n = this.posted.length;
    this.threads.push({ id: `r${n}`, resolvable: false, resolved: false, outdated: false, comments: [{ id: `r${n}`, author: "quost", authorIsBot: false, body: input.body, createdAt: "" }] });
    input.comments.forEach((c, i) =>
      this.threads.push({ id: `t${n}-${i}`, path: c.path, line: c.line, resolvable: true, resolved: false, outdated: false, comments: [{ id: `t${n}-${i}`, author: "quost", authorIsBot: false, body: c.body, createdAt: "" }] }),
    );
    return { url: `${pr.url}#review`, event: input.event, inline: input.comments.length, movedToBody: 0 };
  }
  async reply() {}
  async resolve() {}
  async permission() {
    return "write" as const;
  }
  headRefspec(n: number, local: string) {
    return `+refs/pull/${n}/head:${local}`;
  }
}

function fakeHarness(): Harness & { runs: number } {
  const h = {
    id: "claude",
    name: "Fake Claude",
    kind: "native" as const,
    capabilities: { readOnly: "enforced" as const, write: false, streaming: false, costReport: false, modelSelect: false },
    runs: 0,
    async detect() {
      return { installed: true, version: "test" };
    },
    async run(req: { prompt: string }): Promise<RunResult> {
      h.runs++;
      if (req.prompt.includes("You are the verifier")) return { ok: true, text: '{"decisions":[{"id":"F1","action":"confirm","reason":"pct is a fraction"}]}', exitCode: 0, durationMs: 1 };
      if (req.prompt.includes("Correctness reviewer")) {
        return { ok: true, text: JSON.stringify({ findings: [{ path: "src/cart.ts", line: 2, severity: "major", title: "discount accepts pct above 1", body: "A pct of 20 gives a negative total.", confidence: "high" }] }), exitCode: 0, durationMs: 1 };
      }
      return { ok: true, text: '{"findings":[]}', exitCode: 0, durationMs: 1 };
    },
  };
  return h;
}

function pr(n: number, sha: string, p: Partial<PullRequest> = {}): PullRequest {
  return { number: n, title: "Add discount", body: "Adds a discount helper.", author: "ana", authorIsBot: false, draft: false, state: "open", headSha: sha, headRef: "discount", baseRef: "main", labels: [], updatedAt: "", url: `https://example.test/acme/shop/pull/${n}`, fromFork: false, ...p };
}

async function setup(mode: "inbox" | "auto") {
  const home = await mkdtemp(join(root, "home-"));
  const dirs = appDirs({ CREWREVIEW_HOME: home });
  const ref: RepoRef = { ...repoRef("github", "example.test", "acme/shop"), cloneUrl: remote };
  const repo: LinkedRepo = { ...newRepoEntry(ref, { review: { mode } }), ref };
  const config = parseConfig({ review: { settle: "0s", lenses: ["correctness", "tests"] }, schedule: { maxReviewsPerCycle: 5 } });
  const store = new Store(":memory:");
  const harness = fakeHarness();
  const d: PrDeps = { dirs, config, store, conformance: ConformanceStore.in(dirs.state), registry: new Map([["claude", harness]]), version: "test", ui: createTranslator("en") };
  return { d, repo, ref, store, harness, dirs };
}

describe("repos file", () => {
  test("round-trips through TOML and validates", async () => {
    const dir = await mkdtemp(join(root, "repos-"));
    const path = join(dir, "repos.toml");
    const e = newRepoEntry(repoRef("gitlab", "gitlab.com", "group/sub/app"), { review: { mode: "auto", authors: "all", commentLanguage: "pt-BR" } });
    await saveRepos(path, [e]);
    expect(serializeRepos([e])).toContain('[repo.review]\nmode = "auto"');
    const back = await loadRepos(path);
    expect(back[0]).toMatchObject({ id: "group-sub-app", review: { mode: "auto", authors: "all", commentLanguage: "pt-BR" } });
    expect(back[0]!.ref.apiBase).toBe("https://gitlab.com/api/v4");
    await writeFile(path, '[[repo]]\nid = "x"\nurl = "https://github.com/a/b"\n[repo.review]\nmode = "sometimes"\n');
    await expect(loadRepos(path)).rejects.toThrow();
  });
});

describe("schedule", () => {
  test("peak hours on weekdays, the long interval otherwise", () => {
    const c = parseConfig({ schedule: { interval: "3m", offHoursInterval: "20m", peakHours: "8-19" } });
    expect(nextInterval(c, new Date(2026, 10, 18, 10))).toBe(3 * 60_000); // Wednesday 10:00
    expect(nextInterval(c, new Date(2026, 10, 18, 22))).toBe(20 * 60_000);
    expect(nextInterval(c, new Date(2026, 10, 21, 10))).toBe(20 * 60_000); // Saturday
  });
});

describe("pull request reviews end to end (fake host, real git, fake agents)", () => {
  test("inbox mode: review waits, approval posts inline + summary with markers, the next cycle skips it", async () => {
    const sha = await pushPull(1, "discount");
    const { d, repo, ref, store, harness } = await setup("inbox");
    const host = new FakeHost(ref, [pr(1, sha), pr(2, sha, { author: "quost" }), pr(3, sha, { draft: true })]);
    const target: PrTarget = { repo, host, token: "t" };
    const outcome = await reviewPullRequest(d, target, 1, "inbox");
    expect(outcome.kind).toBe("pending");
    expect(host.posted).toHaveLength(0);
    const row = store.inbox()[0]!;
    expect(row).toMatchObject({ repo: repo.id, number: 1, headSha: sha, status: "pending", findings: 1, event: "comment" });
    const ctx = join(row.jobDir!, "ctx");
    expect(await readFile(join(ctx, "pr.md"), "utf8")).toContain("Adds a discount helper.");
    expect(await readFile(join(ctx, "checks.md"), "utf8")).toContain("State: green");

    const posted = await postReview(d, target, row.id);
    expect(posted).toMatchObject({ kind: "posted", event: "comment" });
    const sent = host.posted[0]!.input;
    expect(sent.comments).toHaveLength(1);
    expect(sent.comments[0]).toMatchObject({ path: "src/cart.ts", line: 2 });
    expect(parseMarker(sent.comments[0]!.body)?.kind).toBe("finding");
    expect(parseMarker(sent.body)).toMatchObject({ kind: "review", ref: sha });
    expect(sent.body).toContain("Crewreview · comment");
    expect(store.get(row.id)?.status).toBe("posted");

    // A forced re-review finds the same problem: it isn't posted again, but it still decides the verdict.
    const forced = await reviewPullRequest(d, target, 1, "dry-run", { force: true });
    expect(forced.kind).toBe("dry-run");
    const rep = (forced as { report: { findings: unknown[]; repeated: { title: string }[]; verdict: { counts: { major: number } } } }).report;
    expect(rep.findings).toHaveLength(0);
    expect(rep.repeated.map((f) => f.title)).toEqual(["discount accepts pct above 1"]);
    expect(rep.verdict.counts.major).toBe(1);

    // Same head again: the marker on the host says it's done, no agent runs.
    const before = harness.runs;
    const again = await reviewPullRequest(d, target, 1, "inbox");
    expect(again).toMatchObject({ kind: "skipped", reason: "already-on-host" });
    expect(harness.runs).toBe(before);
  }, 60_000);

  test("auto mode posts at once; a push that only merges the base is skipped; a stale inbox item is refused", async () => {
    const { d, repo, ref, store } = await setup("auto");
    const sha1 = await pushPull(5, "discount");
    const host = new FakeHost(ref, [pr(5, sha1)]);
    const target: PrTarget = { repo, host, token: "t" };
    expect((await reviewPullRequest(d, target, 5, "auto")).kind).toBe("posted");

    // main moves and is merged into the branch: the branch's own lines are the same.
    await sh(["checkout", "-q", "main"], work);
    await writeFile(join(work, "README.md"), "# shop\n");
    await sh(["add", "-A"], work);
    await sh(["commit", "-qm", "docs"], work);
    await sh(["push", "-q", "origin", "main"], work);
    await sh(["checkout", "-q", "discount"], work);
    await sh(["merge", "-q", "--no-edit", "main"], work);
    const sha2 = await pushPull(5, "discount");
    host.prs = [pr(5, sha2)];
    host.threads = []; // pretend the host lost our marker, so only the signature check can catch it
    expect(await reviewPullRequest(d, target, 5, "auto")).toMatchObject({ kind: "skipped", reason: "merge-only" });

    // A real change, reviewed into the inbox, then another push before approval.
    await writeFile(join(work, "src", "cart.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport const discount = (t: number, pct: number) => t - t * Math.min(pct, 1);\n");
    await sh(["commit", "-qam", "clamp pct"], work);
    const sha3 = await pushPull(5, "discount");
    host.prs = [pr(5, sha3)];
    const pending = await reviewPullRequest(d, target, 5, "inbox");
    expect(pending.kind).toBe("pending");
    const id = (pending as { reviewId: number }).reviewId;
    const report = JSON.parse(await readFile(join(store.get(id)!.jobDir!, "report.json"), "utf8"));
    expect(report.delta).toBe(sha1); // delta from the last posted review
    host.prs = [pr(5, "0000000000000000000000000000000000000000")];
    expect(await postReview(d, target, id)).toMatchObject({ kind: "stale" });
    expect(store.get(id)?.status).toBe("stale");
  }, 60_000);

  test("runCycle respects eligibility and the per-cycle limit", async () => {
    const { d, repo, ref } = await setup("inbox");
    const sha = await pushPull(12, "discount");
    const host = new FakeHost(ref, [pr(10, sha, { author: "quost" }), pr(11, sha, { labels: ["no-ai-review"] }), pr(12, sha)]);
    const events: DaemonEvent[] = [];
    const cycle = await runCycle(d, [repo], (e) => events.push(e), Date.now, async () => ({ repo, host, token: "t" }));
    expect(cycle).toEqual({ reviewed: 1, waiting: 0 });
    expect(events.filter((e) => e.type === "skip").map((e) => (e as { reason: string }).reason)).toEqual(["label"]);
    expect(events.find((e) => e.type === "outcome")).toMatchObject({ number: 12, outcome: { kind: "pending" } });
  }, 60_000);
});

