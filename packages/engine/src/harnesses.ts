import { BUILTIN_ORDER, buildRegistry, resolveHarness, type Harness, type SignIn } from "@crewreview/harness";
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
  | { error: "write-escapes"; name: string }
  | { error: "signed-out"; name: string; command?: string }
  | { error: "paused"; name: string; until: number }
  | { error: "budget"; limit: number };

/** What the limits allow right now: paused harnesses, who takes over, and the daily budget of agent runs. */
export interface PickLimits {
  /** When a harness that hit its usage limit can be used again. */
  pausedUntil?: (harness: string) => number | undefined;
  /** Harnesses to try, in order, while the chosen one is paused. Unset with `auto`: the other installed ones. */
  fallback?: readonly string[];
  /** Agent runs used today and the most allowed. */
  budget?: { used: number; limit: number };
}

async function withLimits(registry: Map<string, Harness>, id: string, limits: PickLimits, pick: (id: string) => Promise<Harness | PickError>): Promise<Harness | PickError> {
  if (limits.budget && limits.budget.used >= limits.budget.limit) return { error: "budget", limit: limits.budget.limit };
  const first = await pick(id);
  if (isPickError(first)) return first;
  const until = limits.pausedUntil?.(first.id);
  if (until === undefined) return first;
  for (const alt of limits.fallback ?? (id === "auto" ? BUILTIN_ORDER : [])) {
    if (alt === first.id || !registry.has(alt) || limits.pausedUntil?.(alt) !== undefined) continue;
    const h = await pick(alt);
    if (!isPickError(h)) return h;
  }
  return { error: "paused", name: first.id, until };
}

const signIns = new Map<string, { at: number; result: SignIn }>();
const SIGN_IN_TTL = 5 * 60_000;

/** The harness's own login, asked at most every few minutes. `unknown` never blocks a run. */
export async function signInOf(h: Harness, now = Date.now()): Promise<SignIn> {
  if (!h.signIn) return { state: "unknown" };
  const hit = signIns.get(h.id);
  if (hit && now - hit.at < SIGN_IN_TTL) return hit.result;
  const result = await h.signIn().catch((): SignIn => ({ state: "unknown" }));
  signIns.set(h.id, { at: now, result });
  return result;
}

/** A signed-out harness would fail every run the same way: say so once, before any work. */
async function signedOut(h: Harness): Promise<PickError | undefined> {
  return (await signInOf(h)).state === "no" ? { error: "signed-out", name: h.id, ...(h.loginCommand ? { command: h.loginCommand } : {}) } : undefined;
}

export async function pickReviewer(registry: Map<string, Harness>, id: string, store: ConformanceStore, limits: PickLimits = {}): Promise<Harness | PickError> {
  return withLimits(registry, id, limits, (x) => reviewerOnce(registry, x, store));
}

export async function reviewerOnce(registry: Map<string, Harness>, id: string, store: ConformanceStore): Promise<Harness | PickError> {
  if (id !== "auto" && !registry.has(id)) return { error: "unknown-harness", name: id };
  const h = await resolveHarness(registry, id);
  if (!h || !(await h.detect()).installed) return { error: "no-harness" };
  const r = await reviewable(h, store);
  if (r === "needs-conformance") return { error: "needs-conformance", name: h.id };
  if (r !== "ok") return { error: "not-read-only", name: h.id };
  return (await signedOut(h)) ?? h;
}

/**
 * The attendant edits files, so its harness must have proven on this machine, for this version, that it can write
 * inside the worktree and can't write outside it (`crewreview doctor --conformance`). No exceptions by flags.
 */
export async function pickWriter(registry: Map<string, Harness>, id: string, store: ConformanceStore, limits: PickLimits = {}): Promise<Harness | PickError> {
  return withLimits(registry, id, limits, (x) => writerOnce(registry, x, store));
}

export async function writerOnce(registry: Map<string, Harness>, id: string, store: ConformanceStore): Promise<Harness | PickError> {
  if (id !== "auto" && !registry.has(id)) return { error: "unknown-harness", name: id };
  const h = await resolveHarness(registry, id);
  if (!h || !(await h.detect()).installed) return { error: "no-harness" };
  if (!h.capabilities.write) return { error: "cannot-write", name: h.id };
  const c = await store.get(h.id, (await h.detect()).version);
  if (c?.writeScope === "fail") return { error: "write-escapes", name: h.id };
  if (c?.writeScope !== "pass") return { error: "needs-write-check", name: h.id };
  return (await signedOut(h)) ?? h;
}

export function isPickError<T extends object = Harness>(x: T | PickError): x is PickError {
  return "error" in x;
}
