import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, git } from "../src/index.ts";

let root: string;
let repo: string;

async function sh(args: string[]) {
  const r = await git(args, repo);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

async function put(path: string, text: string) {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewreview-guidelines-"));
  repo = join(root, "repo");
  await mkdir(repo);
  await sh(["init", "-q", "-b", "main"]);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"]]) await sh(["config", k!, v!]);
  // A long AGENTS.md, like the one that lost most of its rules at 20,000 characters.
  await put("AGENTS.md", `# Rules\n\n${"Keep migrations reversible. ".repeat(2_000)}\nLAST RULE: money is integer cents.\n`);
  await put(".kiro/steering/workflow.md", "Every pull request names its WEMOB ticket.\n");
  await put(".kiro/steering/notes.txt", "not a rule file\n");
  await put("docs/review.md", "Screenshots before and after for UI changes.\n");
  await put("docs/rules/adr.md", "Never change an accepted ADR here.\n");
  await put("src/a.ts", "export const a = 1;\n");
  await sh(["add", "-A"]);
  await sh(["commit", "-qm", "base"]);
  await put("src/a.ts", "export const a = 2;\n");
  await sh(["commit", "-qam", "change"]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project rules for the reviewers", () => {
  test("a long AGENTS.md is read whole, rule folders and the paths a repository names come along", async () => {
    const base = await sh(["rev-parse", "HEAD~1"]);
    const head = await sh(["rev-parse", "HEAD"]);
    const ctx = await buildContext({
      root: repo,
      jobDir: join(root, "job"),
      branch: "change",
      base: "main",
      baseSha: base,
      headSha: head,
      rulesRef: base,
      guidelines: ["docs/review.md", "docs/rules", "../outside.md", "/etc/passwd", "missing.md"],
    });
    expect(ctx.guidelines).toEqual(["AGENTS.md", "docs/review.md", "docs/rules/adr.md", ".kiro/steering/workflow.md"]);
    expect(ctx.guidelinesCut).toEqual([]);
    const text = await readFile(join(root, "job", "ctx", "guidelines.md"), "utf8");
    expect(text).toContain("LAST RULE: money is integer cents.");
    expect(text).toContain("WEMOB ticket");
    expect(text).not.toContain("not a rule file");
  });
});
