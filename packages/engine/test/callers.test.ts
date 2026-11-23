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
  repo = await mkdtemp(join(tmpdir(), "crewreview-callers-"));
  await sh(["init", "-q", "-b", "main"]);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) await sh(["config", k!, v!]);
  await mkdir(join(repo, "lib"), { recursive: true });
  await writeFile(join(repo, "lib", "devices.ex"), "defmodule Devices do\n  def update_fields(d, f) do\n    {:ok, d}\n  end\nend\n");
  // A caller the change won't touch: it only knows :ok.
  await writeFile(join(repo, "lib", "station_live.ex"), "defmodule StationLive do\n  def save(d) do\n    case Devices.update_fields(d, %{}) do\n      {:ok, _} -> :saved\n    end\n  end\nend\n");
  await sh(["add", "-A"]);
  await sh(["commit", "-qm", "base"]);
  await sh(["checkout", "-qb", "feature"]);
  await writeFile(join(repo, "lib", "devices.ex"), "defmodule Devices do\n  def update_fields(d, f) do\n    if f == %{}, do: {:error, :unconfirmed}, else: {:ok, d}\n  end\nend\n");
  await sh(["commit", "-qam", "new outcome"]);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

test("the context lists where each changed function is used, callers outside the diff included", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "crewreview-callers-job-"));
  try {
    await buildContext({ root: repo, branch: "feature", base: "main", baseSha: await sh(["rev-parse", "main"]), headSha: await sh(["rev-parse", "feature"]), rulesRef: await sh(["rev-parse", "main"]), jobDir });
    const callers = await readFile(join(jobDir, "ctx", "callers.md"), "utf8");
    expect(callers).toContain("## update_fields (defined in lib/devices.ex)");
    expect(callers).toContain("- lib/station_live.ex:3: case Devices.update_fields(d, %{}) do");
    // The definition isn't listed as a use.
    expect(callers).not.toContain("lib/devices.ex:2");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
