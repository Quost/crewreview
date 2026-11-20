import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShellEnv, mergePath, parseShellOutput } from "../src/index.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function fakeShell(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-shell-"));
  dirs.push(dir);
  const path = join(dir, "sh");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("the environment of an app opened from the Dock", () => {
  test("reads only the kept variables after the marker, whatever the rc files print", () => {
    const out = "Welcome!\n__crewreview_env__\0PATH=/opt/homebrew/bin:/usr/bin\0CLAUDE_CONFIG_DIR=/Users/a/.claude-x\0CODEX_HOME=\0GH_TOKEN=secret\0LANG=pt_BR.UTF-8\0";
    expect(parseShellOutput(out)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", CLAUDE_CONFIG_DIR: "/Users/a/.claude-x", LANG: "pt_BR.UTF-8" });
    expect(parseShellOutput("no marker")).toEqual({});
  });

  test("PATH keeps its order without repeats", () => {
    expect(mergePath("/a:/b", "/usr/bin:/b", "", undefined, "/c")).toBe("/a:/b:/usr/bin:/c");
  });

  test("takes the shell's PATH first, then the bare one, then the usual folders that exist", async () => {
    // A shell whose rc prints noise, then runs the command it was given.
    const shell = await fakeShell(`echo "motd"; PATH=/home/a/.local/bin:/opt/homebrew/bin:/usr/bin CLAUDE_CONFIG_DIR=/home/a/.claude-y GH_TOKEN=nope; export PATH CLAUDE_CONFIG_DIR GH_TOKEN; eval "$2"`);
    const env = await loginShellEnv({ shell, env: { PATH: "/usr/bin:/bin" }, home: "/home/a", exists: (d) => d === "/home/a/.bun/bin" || d === "/usr/local/bin" });
    expect(env).toEqual({ PATH: "/home/a/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin:/home/a/.bun/bin", CLAUDE_CONFIG_DIR: "/home/a/.claude-y" });
  });

  test("a shell that hangs is given up on, and the usual folders still help", async () => {
    const shell = await fakeShell("sleep 10");
    const started = Date.now();
    const env = await loginShellEnv({ shell, env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: "/mine" }, home: "/home/a", timeoutMs: 200, exists: (d) => d === "/opt/homebrew/bin" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(env).toEqual({ PATH: "/usr/bin:/bin:/opt/homebrew/bin" });
  });
});
