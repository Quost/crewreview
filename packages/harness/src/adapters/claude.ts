import type { Usage } from "@crewreview/core";
import { nativeHarness, type NativeOptions, type ParsedOutput, type StreamParser } from "../native.ts";

/**
 * Claude Code in print mode. The prompt goes on stdin (no argv size limit, and `--tools` is variadic).
 * `--safe-mode` and `--restricted` keep the user's hooks, plugins, MCP servers and settings out of the run.
 */
export function claudeParser(): StreamParser {
  let final: ParsedOutput | undefined;
  let lastText = "";
  return {
    line(line, emit) {
      if (!line.startsWith("{")) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const at = Date.now();
      if (ev.type === "system" && ev.subtype === "init") {
        emit({ type: "status", text: `model ${ev.model ?? "?"}`, at });
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const c of ev.message.content) {
          if (c.type === "text" && typeof c.text === "string") {
            lastText = c.text;
            emit({ type: "text", text: c.text, at });
          } else if (c.type === "tool_use") {
            const target = c.input?.file_path ?? c.input?.path ?? c.input?.pattern ?? "";
            emit({ type: "tool", text: `${c.name}${target ? ` ${target}` : ""}`, at });
          }
        }
      } else if (ev.type === "result") {
        const u = ev.usage ?? {};
        const usage: Usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
        };
        const text = typeof ev.result === "string" ? ev.result : lastText;
        final = ev.is_error || (ev.subtype && ev.subtype !== "success") ? { text: "", usage, error: text || ev.subtype } : { text, usage };
      }
    },
    async finish(stdout) {
      if (final) return final;
      return { text: lastText, error: lastText ? undefined : stdout.trim().slice(-2000) || "no result event" };
    },
  };
}

export function claudeHarness(options: NativeOptions = {}) {
  return nativeHarness(
    {
      id: "claude",
      name: "Claude Code",
      executable: "claude",
      capabilities: { readOnly: "enforced", write: true, streaming: true, costReport: true, modelSelect: true },
      authEnv: [/^ANTHROPIC_/, /^CLAUDE_CODE_/],
      build(req) {
        const tools = req.access === "read" ? "Read,Grep,Glob" : "Read,Grep,Glob,Edit,Write";
        const flags = [
          "-p",
          "--output-format", "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--safe-mode",
          "--restricted",
          `--tools=${tools}`,
        ];
        if (req.access === "write") flags.push("--permission-mode", "acceptEdits");
        if (req.model) flags.push("--model", req.model);
        if (req.effort) flags.push("--effort", req.effort);
        return { flags, stdin: req.prompt };
      },
      parser: claudeParser,
    },
    options,
  );
}
