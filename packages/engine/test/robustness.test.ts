import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, LockedError, treeOracle } from "../src/index.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "crewreview-test-robust-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("treeOracle", () => {
  test("reads inside the tree and refuses a sibling folder with the same prefix", async () => {
    const head = join(dir, "head");
    await mkdir(head, { recursive: true });
    await mkdir(join(dir, "head-other"), { recursive: true });
    await writeFile(join(head, "a.txt"), "one\ntwo\n");
    await writeFile(join(dir, "head-other", "x.txt"), "secret\n");
    const oracle = treeOracle(head);
    expect(oracle.lineCount("a.txt")).toBe(2);
    expect(oracle.lineCount("../head-other/x.txt")).toBeNull();
    expect(oracle.lineCount("../head/a.txt")).toBe(2);
  });
});

describe("acquireLock", () => {
  test("takes a free lock, refuses a live one and replaces a stale one", async () => {
    const state = join(dir, "state");
    const release = await acquireLock(state);
    const file = join(state, "daemon.pid");
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    await release();

    // Another process that's alive holds it.
    const other = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      await writeFile(file, String(other.pid));
      await expect(acquireLock(state)).rejects.toBeInstanceOf(LockedError);
    } finally {
      other.kill();
      await other.exited;
    }

    // A pid no process has.
    await writeFile(file, "2147483646");
    const again = await acquireLock(state);
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    await again();
  });
});
