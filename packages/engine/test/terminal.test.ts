import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { linkTerminalCommand, Store } from "../src/index.ts";

let root: string;
let self: string;

async function script(dir: string, out: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const at = join(dir, "crewreview");
  await writeFile(at, `#!/bin/sh\necho ${out}\n`);
  await chmod(at, 0o755);
  return at;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crewreview-terminal-"));
  self = await script(join(root, "Crewreview.app", "Contents", "MacOS"), "0.16.0");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Shell scripts stand in for the binaries; Windows is left alone by the app anyway.
describe.skipIf(process.platform === "win32")("the app's link for the terminal's crewreview", () => {
  test("a separate copy of Crewreview becomes a link to the app's, and the first one on PATH is the one", async () => {
    const bin = join(root, "a", "bin");
    const old = await script(bin, "0.14.1");
    const later = await script(join(root, "a", "later"), "0.13.0");
    const r = await linkTerminalCommand(self, [join(root, "a", "nothing"), bin, join(root, "a", "later")].join(delimiter));
    expect(r).toEqual({ at: old, was: "0.14.1" });
    expect((await lstat(old)).isSymbolicLink()).toBe(true);
    expect(await readlink(old)).toBe(self);
    expect((await lstat(later)).isSymbolicLink()).toBe(false);
    // Already linked: nothing to do.
    expect(await linkTerminalCommand(self, bin)).toBeUndefined();
  });

  test("a link that isn't to an app (a package manager's) and a file that isn't Crewreview stay as they are", async () => {
    const brew = join(root, "b", "bin");
    await mkdir(brew, { recursive: true });
    const cellar = await script(join(root, "b", "Cellar"), "0.15.0");
    await symlink(cellar, join(brew, "crewreview"));
    expect(await linkTerminalCommand(self, brew)).toBeUndefined();
    expect(await readlink(join(brew, "crewreview"))).toBe(cellar);

    const other = await script(join(root, "c", "bin"), "hello");
    expect(await linkTerminalCommand(self, join(root, "c", "bin"))).toBeUndefined();
    expect((await lstat(other)).isSymbolicLink()).toBe(false);
  });

  test("a link left behind by an app that moved points at this one again", async () => {
    const bin = join(root, "d", "bin");
    await mkdir(bin, { recursive: true });
    await symlink(join(root, "gone", "crewreview"), join(bin, "crewreview"));
    expect(await linkTerminalCommand(self, bin)).toEqual({ at: join(bin, "crewreview"), was: undefined });
    expect(await readlink(join(bin, "crewreview"))).toBe(self);
  });

  test("no crewreview on PATH: nothing is created", async () => {
    expect(await linkTerminalCommand(self, join(root, "e"))).toBeUndefined();
  });
});

describe("failures on a head", () => {
  test("a diff too large, recorded as a failure by versions before 0.12.1, is a skip and doesn't count", () => {
    const store = new Store(":memory:");
    const start = () => store.start({ repo: "r", number: 1156, title: "Angular 20", url: "", headSha: "705a956" });
    store.update(start(), { status: "failed", error: "diff-too-large" });
    store.update(start(), { status: "failed", error: "diff-too-large" });
    expect(store.failures("r", 1156, "705a956")).toBe(0);
    store.update(start(), { status: "failed", error: "parse: the answer wasn't valid JSON" });
    expect(store.failures("r", 1156, "705a956")).toBe(1);
  });
});
