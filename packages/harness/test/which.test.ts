import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "../src/index.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// The desktop app starts with a bare PATH and sets a fuller one once it knows your shell's. Lookups must see it.
test.skipIf(process.platform === "win32")("which follows PATH as it is now, not as the process started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewreview-which-"));
  dirs.push(dir);
  await writeFile(join(dir, "crewreview-fake-agent"), "#!/bin/sh\n");
  await chmod(join(dir, "crewreview-fake-agent"), 0o755);
  const before = process.env.PATH;
  expect(which("crewreview-fake-agent")).toBeUndefined();
  try {
    process.env.PATH = `${dir}:${before}`;
    expect(which("crewreview-fake-agent")).toBe(join(dir, "crewreview-fake-agent"));
  } finally {
    process.env.PATH = before;
  }
});
