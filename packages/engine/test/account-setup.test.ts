import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRef } from "@crewreview/hosts";
import { AccountSignIn, type SignInState } from "../src/index.ts";

// A stand-in for gh: its accounts live in files, and "authorize" holds who typed the code (or "deny").
const FAKE_GH = `#!/bin/sh
D="$FAKEGH_DIR"
case "$1 $2" in
  "auth status")
    printf '{"hosts":{"github.com":['
    sep=""
    while read -r login token; do
      active=false; [ "$login" = "$(cat "$D/active")" ] && active=true
      printf '%s{"login":"%s","active":%s}' "$sep" "$login" "$active"; sep=","
    done < "$D/accounts"
    printf ']}}\\n' ;;
  "auth token")
    while read -r login token; do [ "$login" = "$6" ] && { echo "$token"; exit 0; }; done < "$D/accounts"
    exit 1 ;;
  "auth switch")
    grep -q "^$6 " "$D/accounts" && echo "$6" > "$D/active" ;;
  "auth login")
    [ -n "$FAKEGH_SILENT" ] && { sleep 5; exit 1; }
    echo "! One-time code (ABCD-1234) copied to clipboard" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    i=0; while [ ! -f "$D/authorize" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
    who="$(cat "$D/authorize" 2>/dev/null)"
    [ -z "$who" ] || [ "$who" = deny ] && { echo "error: access denied" >&2; exit 1; }
    grep -v "^$who " "$D/accounts" > "$D/a2"; echo "$who tok-$who" >> "$D/a2"; mv "$D/a2" "$D/accounts"
    echo "$who" > "$D/active"
    echo "✓ Logged in as $who" >&2 ;;
esac
`;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function fakeGh() {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-gh-"));
  dirs.push(dir);
  await writeFile(join(dir, "gh"), FAKE_GH);
  await chmod(join(dir, "gh"), 0o755);
  await writeFile(join(dir, "accounts"), "you tok-you\n");
  await writeFile(join(dir, "active"), "you\n");
  const ref = repoRef("github", "github.com", "crewreview");
  const make = (env: Record<string, string> = {}, codeTimeoutMs?: number) =>
    new AccountSignIn(ref, { gh: join(dir, "gh"), env: { PATH: process.env.PATH, FAKEGH_DIR: dir, ...env }, whoami: async (token) => token.replace(/^tok-/, ""), codeTimeoutMs });
  return { dir, make, active: async () => (await readFile(join(dir, "active"), "utf8")).trim(), authorize: (who: string) => writeFile(join(dir, "authorize"), who) };
}

async function settled(s: AccountSignIn): Promise<SignInState> {
  for (let i = 0; i < 100 && s.status().state === "waiting"; i++) await Bun.sleep(50);
  return s.status();
}

describe("signing a second account in to gh from the app", () => {
  test("shows the code, then signs it in and puts gh back on your account", async () => {
    const gh = await fakeGh();
    const s = gh.make();
    expect(await s.start("acme-crew")).toMatchObject({ state: "waiting", login: "acme-crew", code: "ABCD-1234", url: "https://github.com/login/device" });
    await gh.authorize("acme-crew");
    expect(await settled(s)).toEqual({ state: "done", login: "acme-crew", restoredTo: "you" });
    expect(await gh.active()).toBe("you");
  });

  test("a code typed by another account is caught, and gh still goes back to you", async () => {
    const gh = await fakeGh();
    const s = gh.make();
    await s.start("acme-crew");
    await gh.authorize("someone-else");
    expect(await settled(s)).toMatchObject({ state: "failed", error: "wrong-account", who: "someone-else", restoredTo: "you" });
    expect(await gh.active()).toBe("you");
  });

  test("a refused code, a token in the environment, and a gh that never shows a code", async () => {
    const gh = await fakeGh();
    const refused = gh.make();
    await refused.start("acme-crew");
    await gh.authorize("deny");
    expect(await settled(refused)).toMatchObject({ state: "failed", error: "failed", detail: "error: access denied", restoredTo: "you" });

    expect(await gh.make({ GH_TOKEN: "x" }).start("acme-crew")).toEqual({ state: "failed", login: "acme-crew", error: "gh-token-env", detail: "GH_TOKEN" });
    expect(await gh.make({ FAKEGH_SILENT: "1" }, 300).start("acme-crew")).toMatchObject({ state: "failed", error: "no-code" });
    expect(await gh.active()).toBe("you");
  });

  test("cancel stops waiting and leaves gh as it was", async () => {
    const gh = await fakeGh();
    const s = gh.make();
    await s.start("acme-crew");
    s.cancel();
    expect(s.status()).toEqual({ state: "idle" });
    await Bun.sleep(200);
    expect(await gh.active()).toBe("you");
  });
});
