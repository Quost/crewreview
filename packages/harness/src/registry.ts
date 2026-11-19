import { acpHarness, type AcpAgentConfig } from "./adapters/acp.ts";
import { claudeHarness } from "./adapters/claude.ts";
import { codexHarness } from "./adapters/codex.ts";
import { customHarness, type CustomHarnessConfig } from "./adapters/custom.ts";
import { kiroHarness } from "./adapters/kiro.ts";
import type { Harness } from "./types.ts";

export interface HarnessSettings {
  executable?: string;
  envPassthrough?: string[];
  /** Codex only. */
  isolate?: boolean;
}

export interface RegistryConfig {
  claude?: HarnessSettings;
  codex?: HarnessSettings;
  kiro?: HarnessSettings;
  acp?: AcpAgentConfig[];
  custom?: CustomHarnessConfig[];
}

/** Order used by `auto`: the first installed one wins. */
export const BUILTIN_ORDER = ["claude", "codex", "kiro"] as const;

export function buildRegistry(cfg: RegistryConfig = {}): Map<string, Harness> {
  const list: Harness[] = [
    claudeHarness(cfg.claude),
    codexHarness(cfg.codex),
    kiroHarness(cfg.kiro),
    ...(cfg.acp ?? []).map(acpHarness),
    ...(cfg.custom ?? []).map(customHarness),
  ];
  const map = new Map<string, Harness>();
  for (const h of list) {
    if (map.has(h.id)) throw new Error(`two harnesses share the id "${h.id}"`);
    map.set(h.id, h);
  }
  return map;
}

/** Resolve "auto" to the first installed built-in harness. */
export async function resolveHarness(registry: Map<string, Harness>, id: string): Promise<Harness | undefined> {
  if (id !== "auto") return registry.get(id);
  for (const name of BUILTIN_ORDER) {
    const h = registry.get(name);
    if (h && (await h.detect()).installed) return h;
  }
  return undefined;
}
