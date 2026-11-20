import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, SignIn } from "@crewreview/harness";
import { ConformanceStore, pickReviewer, pickWriter, signInOf } from "../src/index.ts";

/** An ACP-like harness that already passed its conformance test, with a login we control. */
function fake(id: string, login: SignIn | undefined): Harness {
  let asked = 0;
  return {
    id,
    name: id,
    kind: "acp",
    capabilities: { readOnly: "enforced", write: true, streaming: false, costReport: false, modelSelect: false },
    async detect() {
      return { installed: true, path: `/bin/${id}`, version: "1.0" };
    },
    async run() {
      throw new Error("not in this test");
    },
    ...(login
      ? {
          loginCommand: `${id} login`,
          async signIn() {
            asked++;
            (this as any).asked = asked;
            return login;
          },
        }
      : {}),
  };
}

async function proven(ids: string[]): Promise<ConformanceStore> {
  const store = ConformanceStore.in(await mkdtemp(join(tmpdir(), "crewreview-conf-")));
  for (const id of ids) await store.put({ harness: id, version: "1.0", at: new Date().toISOString(), structured: "pass", readOnly: "pass", writeScope: "pass", durationMs: 1 });
  return store;
}

describe("harness login", () => {
  test("a signed-out harness stops the pick with the command that fixes it", async () => {
    const store = await proven(["out", "in", "dunno", "silent"]);
    const registry = new Map<string, Harness>([
      ["out", fake("out", { state: "no" })],
      ["in", fake("in", { state: "yes", expiresAt: "2030-01-01T00:00:00Z" })],
      ["dunno", fake("dunno", { state: "unknown" })],
      ["silent", fake("silent", undefined)],
    ]);
    expect(await pickReviewer(registry, "out", store)).toEqual({ error: "signed-out", name: "out", command: "out login" });
    expect(await pickWriter(registry, "out", store)).toEqual({ error: "signed-out", name: "out", command: "out login" });
    // Signed in, can't tell, or no way to ask: the run goes ahead and its own error, if any, says why.
    for (const id of ["in", "dunno", "silent"]) expect((await pickReviewer(registry, id, store)) as Harness).toBe(registry.get(id)!);
  });

  test("the login is asked at most every few minutes", async () => {
    const h = fake("cached", { state: "yes" });
    await signInOf(h, 1_000);
    await signInOf(h, 2_000);
    expect((h as any).asked).toBe(1);
    await signInOf(h, 1_000 + 6 * 60_000);
    expect((h as any).asked).toBe(2);
  });
});
