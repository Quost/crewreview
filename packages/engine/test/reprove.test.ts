import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, RunRequest, RunResult } from "@crewreview/harness";
import { createTranslator } from "@crewreview/i18n";
import { appDirs, ConformanceStore, CrewDaemon, parseConfig, Store } from "../src/index.ts";

let home: string;
let dirs: ReturnType<typeof appDirs>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "crewreview-reprove-"));
  dirs = appDirs({ CREWREVIEW_HOME: home });
});
afterEach(() => rm(home, { recursive: true, force: true }));

/** A harness at some version whose runs all end the same way; counts how often it was asked. */
function fake(version: string) {
  const h = {
    id: "fake",
    name: "Fake",
    kind: "cli",
    capabilities: { readOnly: "enforced", write: true, streaming: false, costReport: false, modelSelect: false },
    runs: 0,
    detect: async () => ({ installed: true, version }),
    run: async (_r: RunRequest): Promise<RunResult> => {
      h.runs++;
      return { ok: false, failure: "auth", error: "signed out" } as RunResult;
    },
  };
  return h as typeof h & Harness;
}

const passed = (version: string) => ({ harness: "fake", version, at: new Date().toISOString(), structured: "pass", readOnly: "pass", writeScope: "pass", durationMs: 1 }) as const;

function crewWith(h: Harness, conformance: ConformanceStore) {
  return new CrewDaemon({ dirs, config: parseConfig({}), version: "test", ui: createTranslator("en"), store: new Store(":memory:"), conformance, registry: new Map([[h.id, h]]) });
}

describe("a harness that updated", () => {
  test("proves its new version before the check, once, and says how it went", async () => {
    const conformance = ConformanceStore.in(dirs.state);
    await conformance.put(passed("1.0"));
    const h = fake("1.1");
    const crew = crewWith(h, conformance);

    await crew.cycle();
    expect(h.runs).toBeGreaterThan(0);
    expect((await conformance.get("fake", "1.1"))?.readOnly).not.toBe("pass");
    const said = crew.recentLog().map((e) => e.event).filter((e) => e.type === "reproved");
    expect(said).toEqual([{ type: "reproved", harness: "fake", version: "1.1", passed: false }]);

    const runs = h.runs;
    await crew.cycle();
    expect(h.runs).toBe(runs);
  });

  test("a harness never proven here waits for the user to prove it", async () => {
    const h = fake("1.1");
    const crew = crewWith(h, ConformanceStore.in(dirs.state));
    await crew.cycle();
    expect(h.runs).toBe(0);
  });

  test("a version already proven isn't proven again", async () => {
    const conformance = ConformanceStore.in(dirs.state);
    await conformance.put(passed("1.1"));
    const h = fake("1.1");
    await crewWith(h, conformance).cycle();
    expect(h.runs).toBe(0);
  });
});
