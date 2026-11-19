import { buildRegistry, resolveHarness, type Harness } from "@crewreview/harness";
import type { Config } from "./config.ts";
import type { ConformanceStore } from "./conformance-store.ts";

export function registryFor(config: Config): Map<string, Harness> {
  const h = config.harness;
  return buildRegistry({ claude: h.claude, codex: h.codex, kiro: h.kiro, acp: h.acp, custom: h.custom });
}

const VERIFIED_BY_FLAGS = new Set(["claude", "codex", "kiro"]);

export type Reviewability = "ok" | "not-read-only" | "needs-conformance" | "failed-conformance";

/** A harness may review only when its read-only lock holds. ACP and custom harnesses must prove it first. */
export async function reviewable(h: Harness, store: ConformanceStore): Promise<Reviewability> {
  if (h.capabilities.readOnly !== "enforced") return "not-read-only";
  const det = await h.detect();
  const c = await store.get(h.id, det.version);
  if (c?.readOnly === "fail") return "failed-conformance";
  if (h.kind !== "native" || !VERIFIED_BY_FLAGS.has(h.id)) {
    if (c?.readOnly !== "pass") return "needs-conformance";
  }
  return "ok";
}

export type PickError =
  | { error: "unknown-harness"; name: string }
  | { error: "no-harness" }
  | { error: "needs-conformance"; name: string }
  | { error: "not-read-only"; name: string }
  | { error: "cannot-write"; name: string }
  | { error: "needs-write-check"; name: string }
  | { error: "write-escapes"; name: string };

export async function pickReviewer(registry: Map<string, Harness>, id: string, store: ConformanceStore): Promise<Harness | PickError> {
  if (id !== "auto" && !registry.has(id)) return { error: "unknown-harness", name: id };
  const h = await resolveHarness(registry, id);
  if (!h || !(await h.detect()).installed) return { error: "no-harness" };
  const r = await reviewable(h, store);
  if (r === "needs-conformance") return { error: "needs-conformance", name: h.id };
  if (r !== "ok") return { error: "not-read-only", name: h.id };
  return h;
}

/**
 * The attendant edits files, so its harness must have proven on this machine, for this version, that it can write
 * inside the worktree and can't write outside it (`crewreview doctor --conformance`). No exceptions by flags.
 */
export async function pickWriter(registry: Map<string, Harness>, id: string, store: ConformanceStore): Promise<Harness | PickError> {
  if (id !== "auto" && !registry.has(id)) return { error: "unknown-harness", name: id };
  const h = await resolveHarness(registry, id);
  if (!h || !(await h.detect()).installed) return { error: "no-harness" };
  if (!h.capabilities.write) return { error: "cannot-write", name: h.id };
  const c = await store.get(h.id, (await h.detect()).version);
  if (c?.writeScope === "fail") return { error: "write-escapes", name: h.id };
  if (c?.writeScope !== "pass") return { error: "needs-write-check", name: h.id };
  return h;
}

export function isPickError(x: Harness | PickError): x is PickError {
  return "error" in x;
}
