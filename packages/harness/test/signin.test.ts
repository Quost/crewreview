import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeHarness, codexHarness } from "../src/index.ts";

/** A stand-in for the harness CLI: answers its status command the way the real one does, from an env var. */
async function fakeCli(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-cli-"));
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("sign-in check", () => {
  test("Claude Code: the JSON status, with when the login expires", async () => {
    const exe = await fakeCli(
      "claude",
      `[ "$1 $2" = "auth status" ] || exit 9
if [ "$FAKE_LOGIN" = yes ]; then echo '{"loggedIn":true,"loginExpiresAt":"2030-01-02T03:04:05Z"}'; else echo '{"loggedIn":false}'; exit 1; fi`,
    );
    const h = claudeHarness({ executable: exe });
    expect(await h.signIn!({ ...process.env, FAKE_LOGIN: "yes" })).toEqual({ state: "yes", expiresAt: "2030-01-02T03:04:05Z" });
    expect(await h.signIn!({ ...process.env, FAKE_LOGIN: "no" })).toEqual({ state: "no" });
    expect(h.loginCommand).toBe("claude auth login");
  });

  test("Codex: the exit code; and a PATH without the CLI says so", async () => {
    const exe = await fakeCli("codex", `[ "$1 $2" = "login status" ] || exit 9\n[ "$FAKE_LOGIN" = yes ] && echo "Logged in" && exit 0\necho "Not logged in"; exit 1`);
    const dir = exe.slice(0, -"/codex".length);
    const h = codexHarness();
    expect(await h.signIn!({ PATH: `${dir}:/usr/bin:/bin`, FAKE_LOGIN: "yes" })).toEqual({ state: "yes" });
    expect(await h.signIn!({ PATH: `${dir}:/usr/bin:/bin`, FAKE_LOGIN: "no" })).toEqual({ state: "no" });
    expect(await h.signIn!({ PATH: "/nowhere" })).toEqual({ state: "unknown", reason: "missing" });
  });
});
