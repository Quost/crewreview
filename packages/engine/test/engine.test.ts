import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, RunRequest, RunResult } from "@crewreview/harness";
import { appDirs, git, loadLenses, localTarget, parseConfig, parseDuration, runReview, type Lens } from "../src/index.ts";

let repo: string;
let home: string;

async function sh(args: string[], cwd = repo) {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "crewreview-test-repo-"));
  home = await mkdtemp(join(tmpdir(), "crewreview-test-home-"));
  await sh(["init", "-q", "-b", "main"]);
  await sh(["config", "user.email", "t@example.com"]);
  await sh(["config", "user.name", "T"]);
  await sh(["config", "commit.gpgsign", "false"]);
  await sh(["config", "core.autocrlf", "false"]);
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, ".crewreview", "lenses"), { recursive: true });
  await writeFile(join(repo, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
  await writeFile(join(repo, "AGENTS.md"), "Always use tabs.\n");
  await writeFile(join(repo, ".crewreview", "lenses", "security.md"), "# Our security\n\nCheck tenant ids.\n");
  await writeFile(join(repo, ".crewreview", "lenses", "i18n.md"), "# Translations\n\nEvery string translated.\n");
  await sh(["add", "-A"]);
  await sh(["commit", "-qm", "base"]);
  await sh(["checkout", "-qb", "feature"]);
  await writeFile(join(repo, "src", "math.ts"), "export const add = (a: number, b: number) => a - b;\nexport const half = (n: number) => n / 2;\n");
  await sh(["commit", "-qam", "change add"]);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("config", () => {
  test("defaults, durations and typos", () => {
    const c = parseConfig({ limits: { agentTimeout: "90s" } });
    expect(c.limits.agentTimeout).toBe(90_000);
    expect(c.limits.stallTimeout).toBe(8 * 60_000);
    expect(c.review.policy.allowApprove).toBe(false);
    expect(c.harness.default).toBe("auto");
    expect(() => parseConfig({ reveiw: {} })).toThrow();
    expect(() => parseConfig({ limits: { agentTimeout: "soon" } })).toThrow();
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  test("dirs follow each OS", () => {
    expect(appDirs({ HOME: "/h" }, "linux").config).toBe(join("/h", ".config", "crewreview"));
    expect(appDirs({ HOME: "/h" }, "darwin").data).toBe(join("/h", "Library", "Application Support", "Crewreview"));
    expect(appDirs({ HOME: "C:\\u", APPDATA: "C:\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\u\\AppData\\Local" }, "win32").config).toContain("Crewreview");
    expect(appDirs({ CREWREVIEW_HOME: "/x" }, "linux").state).toBe(join("/x", "state"));
  });
});

describe("lenses", () => {
  test("the repo can replace a rubric and add a lens", async () => {
    const lenses = await loadLenses(repo, "HEAD");
    const sec = lenses.find((l) => l.id === "security")!;
    expect(sec.source).toBe("repo");
    expect(sec.title).toBe("Our security");
    expect(lenses.find((l) => l.id === "i18n")?.title).toBe("Translations");
    expect(lenses.find((l) => l.id === "correctness")?.source).toBe("builtin");
  });
});

/** A scripted harness: answers by role, records every prompt, never calls a model. */
function fakeHarness(answers: (req: RunRequest) => string): Harness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake",
    name: "Fake",
    kind: "native",
    capabilities: { readOnly: "enforced", write: false, streaming: false, costReport: false, modelSelect: false },
    prompts,
    async detect() {
      return { installed: true, version: "1" };
    },
    async run(req): Promise<RunResult> {
      prompts.push(req.prompt);
      expect(req.access).toBe("read");
      expect(existsSync(join(req.cwd, "head", "src", "math.ts"))).toBe(true);
      expect(existsSync(join(req.cwd, "ctx", "diff.patch"))).toBe(true);
      return { ok: true, text: answers(req), exitCode: 0, durationMs: 5, usage: { inputTokens: 10, outputTokens: 2 } };
    },
  };
}

describe("review pipeline", () => {
  test("lenses → evidence → dedupe → verifier → verdict, without touching the user's repo", async () => {
    const statusBefore = await sh(["status", "--porcelain"]);
    const worktreesBefore = await sh(["worktree", "list"]);
    const target = await localTarget({ cwd: repo });
    expect(target.base).toBe("main");

    const h = fakeHarness((req) => {
      if (req.prompt.includes("You are the verifier")) {
        return JSON.stringify({ decisions: [{ id: "F1", action: "confirm", reason: "a - b" }, { id: "F2", action: "drop", reason: "fine" }] });
      }
      if (req.prompt.includes("Correctness reviewer")) {
        return "Sure!\n```json\n" + JSON.stringify({
          findings: [
            { path: "src/math.ts", line: 1, severity: "critical", title: "add subtracts", body: "`add` returns a - b.", confidence: "high" },
            { path: "src/math.ts", line: 99, severity: "major", title: "past the end", body: "x" },
          ],
        }) + "\n```";
      }
      if (req.prompt.includes("Tests reviewer")) {
        return JSON.stringify({ findings: [{ path: "head/src/math.ts", line: 2, severity: "nit", title: "half has no test", body: "Add one." }] });
      }
      return JSON.stringify({ findings: [] });
    });

    const all = await loadLenses(target.root, target.rulesRef);
    const lenses: Lens[] = all.filter((l) => ["correctness", "security", "tests", "ui"].includes(l.id));
    const report = await runReview(
      { target, jobDir: join(home, "job"), lenses, partial: false, harness: h, config: parseConfig({}), language: "English", policy: parseConfig({}).review.policy },
      "test",
    );

    // ui doesn't apply to a .ts change outside UI folders
    expect(report.lenses.map((l) => l.lens).sort()).toEqual(["correctness", "security", "tests"]);
    expect(report.droppedByEvidence).toBe(1);
    expect(report.findings.map((f) => [f.id, f.severity, f.path])).toEqual([["F1", "blocker", "src/math.ts"]]);
    expect(report.verifier).toMatchObject({ ran: true, ok: true, downgraded: 0 });
    expect(report.verdict.event).toBe("request_changes");
    expect(report.usage.inputTokens).toBe(40);
    // The repository's own security rubric is fenced as data.
    const secPrompt = h.prompts.find((p) => p.includes("Our security"))!;
    expect(secPrompt).toContain("<untrusted-rubric nonce=");
    expect(await readFile(join(home, "job", "ctx", "guidelines.md"), "utf8")).toContain("Always use tabs.");
    // Nothing changed in the user's checkout.
    expect(await sh(["status", "--porcelain"])).toBe(statusBefore);
    expect(await sh(["worktree", "list"])).toBe(worktreesBefore);
  }, 60_000);

  test("an unparseable lens fails alone; all failing is an error", async () => {
    const target = await localTarget({ cwd: repo });
    const lenses = (await loadLenses(target.root, target.rulesRef)).filter((l) => ["correctness", "security"].includes(l.id));
    const half = fakeHarness((req) => (req.prompt.includes("Correctness") ? "no json" : JSON.stringify({ findings: [] })));
    const r = await runReview({ target, jobDir: join(home, "job2"), lenses, partial: false, harness: half, config: parseConfig({}), language: "English", policy: parseConfig({}).review.policy }, "test");
    expect(r.lenses.find((l) => l.lens === "correctness")?.status).toBe("failed");
    expect(r.verdict.reasons).toContain("lens-failed");

    const none = fakeHarness(() => "nothing useful");
    await expect(
      runReview({ target, jobDir: join(home, "job3"), lenses, partial: false, harness: none, config: parseConfig({}), language: "English", policy: parseConfig({}).review.policy }, "test"),
    ).rejects.toThrow("all-lenses-failed");
  }, 60_000);

  test("uncommitted changes are reviewed from a stash commit, leaving the work tree alone", async () => {
    await writeFile(join(repo, "src", "math.ts"), "export const add = (a: number, b: number) => a + b;\n");
    try {
      const t = await localTarget({ cwd: repo, uncommitted: true });
      expect(t.headSha).not.toBe(await sh(["rev-parse", "HEAD"]));
      expect(await sh(["stash", "list"])).toBe("");
    } finally {
      await sh(["checkout", "--", "src/math.ts"]);
    }
  }, 60_000);
});
