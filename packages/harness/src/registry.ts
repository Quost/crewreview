import { acpHarness, type AcpAgentConfig } from "./adapters/acp.ts";
import { claudeHarness } from "./adapters/claude.ts";
import { codexHarness } from "./adapters/codex.ts";
import { customHarness, type CustomHarnessConfig } from "./adapters/custom.ts";
import { kiroHarness } from "./adapters/kiro.ts";
import { kiloGatewayHarness } from "./adapters/kilo-gateway.ts";
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
  kiloGateway?: HarnessSettings;
  acp?: AcpAgentConfig[];
  custom?: CustomHarnessConfig[];
}

/** Order used by `auto`: the first installed one wins. */
export const BUILTIN_ORDER = ["claude", "codex", "kiro", "kilo-gateway"] as const;

/**
 * Agents known to speak the Agent Client Protocol: they appear when installed, with no config. Our ACP client answers
 * every permission request and serves file reads itself, so read-only holds whatever the agent would do on its own;
 * they still review only after `doctor --conformance` (or the dashboard's Prove button) passes for their version.
 * An `[[harness.acp]]` entry with the same id replaces the preset.
 */
export const ACP_PRESETS: readonly AcpAgentConfig[] = [
  {
    id: "agy",
    name: "Antigravity",
    command: ["agy", "acp"],
    installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    signupUrl: "https://antigravity.google/download",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: ["opencode", "acp"],
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
    signupUrl: "https://opencode.ai/download",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: ["gemini", "--experimental-acp"],
    authEnv: ["^GEMINI_API_KEY$", "^GOOGLE_API_KEY$", "^GOOGLE_GENAI_USE_VERTEXAI$", "^GOOGLE_CLOUD_PROJECT$"],
    installCommand: "npm install -g @google/gemini-cli",
    signupUrl: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "freebuff",
    name: "Freebuff",
    command: ["freebuff", "--acp"],
    authEnv: ["^FREEBUFF_"],
    loginCommand: "freebuff login",
    installCommand: "npm i -g freebuff",
    // The link that gets someone a Freebuff account; Crewreview's install hints and Harnesses & limits point here.
    signupUrl: "https://freebuff.com/?ref=ref-bee41763-3c54-4f61-be0e-b892a627cc12&via=rewards_link",
  },
];

export function buildRegistry(cfg: RegistryConfig = {}): Map<string, Harness> {
  const list: Harness[] = [
    claudeHarness(cfg.claude),
    codexHarness(cfg.codex),
    kiroHarness(cfg.kiro),
    kiloGatewayHarness(cfg.kiloGateway),
    ...ACP_PRESETS.filter((p) => !(cfg.acp ?? []).some((a) => a.id === p.id)).map(acpHarness),
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
