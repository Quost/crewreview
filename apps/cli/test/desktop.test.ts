import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { managedByDesktop } from "@crewreview/engine";
import { catalogs, LOCALES, templates } from "@crewreview/i18n";

const MAIN = resolve(import.meta.dir, "..", "src", "main.ts");

describe("templates for the desktop app", () => {
  test("every locale sends the same keys, placeholders untouched", () => {
    const en = templates("en", "desktop.");
    expect(en.inbox).toBe("Inbox ({count})");
    expect(en.running).toContain("{version}");
    for (const l of LOCALES) expect(Object.keys(templates(l, "desktop.")).sort()).toEqual(Object.keys(en).sort());
    expect(templates("pt-BR", "desktop.").quit).toBe(catalogs["pt-BR"]["desktop.quit"]!);
  });
});

describe("managedByDesktop", () => {
  test("a binary inside a macOS app bundle, or one the app started", () => {
    expect(managedByDesktop("/Applications/Crewreview.app/Contents/MacOS/crewreview", {})).toBe(true);
    expect(managedByDesktop("/opt/homebrew/bin/crewreview", {})).toBe(false);
    expect(managedByDesktop("C:\\Program Files\\Crewreview\\crewreview.exe", { CREWREVIEW_DESKTOP: "1" })).toBe(true);
  });
});

/** Run the CLI from source like the desktop app does, reading its JSON lines. */
function spawnDesktop(home: string) {
  const p = Bun.spawn(["bun", MAIN, "run", "--desktop"], {
    env: { ...process.env, CREWREVIEW_HOME: home, CREWREVIEW_LANG: "pt-BR" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = p.stdout.getReader();
  let buffer = "";
  async function next(): Promise<Record<string, any>> {
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        return JSON.parse(line);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdout closed; stderr: ${await new Response(p.stderr).text()}`);
      buffer += new TextDecoder().decode(value);
    }
  }
  return { p, next };
}

describe("run --desktop", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "crewreview-desktop-"));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("starts the crew, attaches a second app to it, and stops when stdin closes", async () => {
    const first = spawnDesktop(home);
    const hello = await first.next();
    expect(hello.locale).toBe("pt-BR");
    expect(hello.strings.quit).toBe("Sair do Crewreview");
    expect(hello.updateCheck).toBe(true);
    const ready = (await first.next()).ready;
    expect(ready.url).toBe(`http://127.0.0.1:${ready.port}/`);
    expect(ready.token.length).toBeGreaterThan(20);
    const state = await fetch(`${ready.url}api/state`, { headers: { authorization: `Bearer ${ready.token}` } });
    expect(((await state.json()) as any).status.inbox).toBe(0);

    // A second app (or a second launch) finds the first crew and reports it instead of starting another.
    const second = spawnDesktop(home);
    await second.next();
    expect((await second.next()).attach).toEqual(ready);
    expect(await second.p.exited).toBe(0);

    first.p.stdin.end();
    expect(await first.p.exited).toBe(0);
    expect(await stat(join(home, "state", "api.json")).catch(() => "gone")).toBe("gone");
  }, 30_000);
});
