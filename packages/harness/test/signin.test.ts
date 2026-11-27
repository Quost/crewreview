import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acpHarness, buildRegistry, claudeHarness, codexHarness } from "../src/index.ts";

/** A stand-in for the harness CLI: answers its status command the way the real one does, from an env var. */
async function fakeCli(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-cli-"));
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe.skipIf(process.platform === "win32")("sign-in check of the ACP agents", () => {
  /** A home with the agent's executable on PATH, and whatever login files the test writes. */
  async function setup(): Promise<{ env: { PATH: string; HOME: string }; write(file: string, text: string): Promise<void> }> {
    const home = await mkdtemp(join(tmpdir(), "crewreview-acp-home-"));
    const bin = await mkdtemp(join(tmpdir(), "crewreview-acp-bin-"));
    for (const name of ["agy", "opencode", "gemini", "freebuff"]) {
      // Signed out unless the test says otherwise: a status command that fails.
      await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n");
      await chmod(join(bin, name), 0o755);
    }
    return {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      async write(file, text) {
        const path = join(home, file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, text);
      },
    };
  }

  test("no saved login and no key is not signed in; a dash before, not now", async () => {
    const { env } = await setup();
    const reg = buildRegistry();
    for (const id of ["agy", "opencode", "gemini", "freebuff"]) {
      expect(reg.get(id)!.signIn).toBeFunction();
      expect(await reg.get(id)!.signIn!(env)).toEqual({ state: "no" });
    }
    // An ACP agent that never said where it keeps its login stays unknown, and shows a dash as before.
    expect(acpHarness({ id: "mine", command: ["mine", "acp"] }).signIn).toBeUndefined();
  });

  test("each agent's saved login file is read, including a raw token", async () => {
    const { env, write } = await setup();
    const reg = buildRegistry();
    await write(".config/manicode/credentials.json", JSON.stringify({ default: { authToken: "t" } }));
    await write(".local/share/opencode/auth.json", JSON.stringify({ anthropic: { type: "api" } }));
    await write(".gemini/oauth_creds.json", JSON.stringify({ access_token: "t", refresh_token: "r" }));
    await write(".gemini/antigravity-cli/antigravity-oauth-token", "ya29.token\n");
    for (const id of ["agy", "opencode", "gemini", "freebuff"]) expect(await reg.get(id)!.signIn!(env)).toEqual({ state: "yes" });
  });

  test("an emptied file, an agent's own key, and the folder it was told to use", async () => {
    const { env, write } = await setup();
    const reg = buildRegistry();
    await write(".config/manicode/credentials.json", "{}");
    expect(await reg.get("freebuff")!.signIn!(env)).toEqual({ state: "no" });
    // Freebuff's config folder can be moved, and the key in the environment is a login of its own.
    expect(await reg.get("gemini")!.signIn!({ ...env, GEMINI_API_KEY: "k" })).toEqual({ state: "yes" });
    await write("moved/credentials.json", JSON.stringify({ default: { authToken: "t" } }));
    expect(await reg.get("freebuff")!.signIn!({ ...env, FREEBUFF_CONFIG_DIR: join(env.HOME, "moved") })).toEqual({ state: "yes" });
    // OpenCode can be told to keep its data elsewhere too.
    await write("data/opencode/auth.json", JSON.stringify({ openai: { type: "oauth" } }));
    expect(await reg.get("opencode")!.signIn!({ ...env, XDG_DATA_HOME: join(env.HOME, "data") })).toEqual({ state: "yes" });
  });

  test("an agent whose login only it can see is asked, and answers", async () => {
    const { env } = await setup();
    const reg = buildRegistry();
    // Antigravity keeps its token in the system keyring: listing its models is the answer, and it needs the login.
    const agy = join(env.PATH.split(":")[0]!, "agy");
    await writeFile(agy, "#!/bin/sh\n[ \"$1\" = models ] || exit 9\n[ \"$FAKE_LOGIN\" = yes ] && exit 0\nexit 1\n");
    await chmod(agy, 0o755);
    expect(await reg.get("agy")!.signIn!({ ...env, FAKE_LOGIN: "yes" })).toEqual({ state: "yes" });
    expect(await reg.get("agy")!.signIn!({ ...env, FAKE_LOGIN: "no" })).toEqual({ state: "no" });
  });

  test("an agent that isn't on PATH says so", async () => {
    const reg = buildRegistry();
    expect(await reg.get("agy")!.signIn!({ PATH: "/nowhere", HOME: "/tmp" })).toEqual({ state: "unknown", reason: "missing" });
  });
});

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
