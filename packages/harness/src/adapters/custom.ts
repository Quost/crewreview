import { nativeHarness, textParser, type StreamParser } from "../native.ts";
import { claudeParser } from "./claude.ts";
import { codexParser } from "./codex.ts";

export interface CustomHarnessConfig {
  id: string;
  name?: string;
  /** Full command for read mode. `{prompt}` and `{cwd}` are replaced; without `{prompt}` the prompt goes on stdin. */
  read?: string[];
  /** Full command for write mode (optional). */
  write?: string[];
  /** How to read the answer. */
  output?: "text" | "claude-stream-json" | "codex-jsonl";
  envPassthrough?: string[];
  authEnv?: string[];
}

/**
 * Any CLI, described in config. Its read command is only trusted after `crewreview doctor --conformance` proves the
 * canary write fails; until then the lenses refuse it.
 */
export function customHarness(cfg: CustomHarnessConfig) {
  const parser: () => StreamParser =
    cfg.output === "claude-stream-json" ? claudeParser : cfg.output === "codex-jsonl" ? codexParser : textParser;
  const base = cfg.read ?? cfg.write;
  if (!base || base.length === 0) throw new Error(`custom harness ${cfg.id}: needs a read or write command`);
  return nativeHarness(
    {
      id: cfg.id,
      name: cfg.name ?? cfg.id,
      executable: base[0]!,
      capabilities: {
        readOnly: cfg.read ? "enforced" : "unsupported",
        write: cfg.write !== undefined,
        streaming: cfg.output !== undefined && cfg.output !== "text",
        costReport: cfg.output === "claude-stream-json",
        modelSelect: false,
      },
      authEnv: (cfg.authEnv ?? []).map((p) => new RegExp(p)),
      build(req) {
        const template = (req.access === "read" ? cfg.read : cfg.write) ?? [];
        const usesPrompt = template.some((a) => a.includes("{prompt}"));
        const args = template.slice(1).map((a) => a.replaceAll("{cwd}", req.cwd));
        if (!usesPrompt) return { flags: args, stdin: req.prompt };
        const idx = args.findIndex((a) => a.includes("{prompt}"));
        const flags = args.filter((_, i) => i !== idx);
        // The prompt must be the last argument so the deny-list check covers every flag.
        if (idx !== args.length - 1) throw new Error(`custom harness ${cfg.id}: {prompt} must be the last argument`);
        return { flags, promptArg: args[idx]!.replaceAll("{prompt}", req.prompt) };
      },
      parser,
    },
    { envPassthrough: cfg.envPassthrough },
  );
}
