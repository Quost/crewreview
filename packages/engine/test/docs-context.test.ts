import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, git } from "../src/index.ts";

let repo: string;
async function sh(args: string[]) {
  const r = await git(args, repo);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "crewreview-docs-"));
  await sh(["init", "-q", "-b", "main"]);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await sh(["config", k!, v!]);
  await mkdir(join(repo, "config"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await mkdir(join(repo, "scripts"), { recursive: true });
  await writeFile(join(repo, "config", "runtime.exs"), 'import Config\nconfig :app, legacy: System.get_env("LEGACY_TOKEN")\n');
  await writeFile(join(repo, ".env.example"), "LEGACY_TOKEN=\n");
  await writeFile(join(repo, "docs", "DEPLOY.md"), "# Deploy\n\nSet LEGACY_TOKEN.\n");
  await writeFile(join(repo, "docs", "integration.md"), "# Integration\n\n`node scripts/backfill-deals.mjs` is idempotent by deal_id.\n");
  await writeFile(join(repo, "scripts", "backfill-deals.mjs"), "export function run() {}\n");
  await sh(["add", "-A"]);
  await sh(["commit", "-qm", "base"]);
  await sh(["checkout", "-qb", "feature"]);
  await writeFile(join(repo, "config", "runtime.exs"), 'import Config\nconfig :app, psk: System.get_env("BOOTSTRAP_PSK")\n');
  await writeFile(join(repo, "scripts", "backfill-deals.mjs"), "export function run() {\n  throw new Error('stop');\n}\n");
  await sh(["commit", "-qam", "new setting"]);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("the context lists settings the change reads and docs that describe what it changed", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "crewreview-docs-job-"));
  try {
    await buildContext({ root: repo, branch: "feature", base: "main", baseSha: await sh(["rev-parse", "main"]), headSha: await sh(["rev-parse", "feature"]), rulesRef: await sh(["rev-parse", "main"]), jobDir });
    const docs = await readFile(join(jobDir, "ctx", "docs.md"), "utf8");
    expect(docs).toContain("- BOOTSTRAP_PSK, read at config/runtime.exs:2");
    expect(docs).toContain("  - not mentioned in: .env.example, docs/DEPLOY.md");
    expect(docs).toContain("- LEGACY_TOKEN, was read in config/runtime.exs");
    expect(docs).toContain("  - .env.example:1: LEGACY_TOKEN=");
    expect(docs).toContain('- "backfill-deals.mjs" (scripts/backfill-deals.mjs)');
    expect(docs).toContain("  - docs/integration.md:3: `node scripts/backfill-deals.mjs` is idempotent by deal_id.");
    // The same line isn't listed again under the name without its extension.
    expect(docs).not.toContain('- "backfill-deals" (');
    expect(docs).toContain("- Environment examples: .env.example");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
