import { nativeHarness, readIfExists, type NativeOptions, type StreamParser } from "../native.ts";

export interface CodexOptions extends NativeOptions {
  /** Skip the user's config.toml and rules (default true). Turn off if you rely on a custom model provider. */
  isolate?: boolean;
}

/** Codex `exec` events (JSONL with --json). The final answer also lands in the -o file. */
export function codexParser(): StreamParser {
  let lastMessage = "";
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
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
      const item = ev.item;
      if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        lastMessage = item.text;
        emit({ type: "text", text: item.text, at });
      } else if (ev.type === "item.started" && item?.type === "command_execution") {
        emit({ type: "tool", text: `shell ${String(item.command ?? "").slice(0, 120)}`, at });
      } else if (ev.type === "item.completed" && item?.type === "file_change") {
        emit({ type: "tool", text: "edit", at });
      } else if (ev.type === "turn.completed" && ev.usage) {
        sawUsage = true;
        inputTokens += ev.usage.input_tokens ?? 0;
        outputTokens += ev.usage.output_tokens ?? 0;
      } else if (ev.type === "turn.failed" || ev.type === "error") {
        error = ev.error?.message ?? ev.message ?? "codex error";
      }
    },
    async finish(_stdout, outputFile) {
      const fromFile = (await readIfExists(outputFile))?.trim();
      const text = fromFile || lastMessage;
      const usage = sawUsage ? { inputTokens, outputTokens } : undefined;
      return { text: error && !text ? "" : text, usage, error: text ? undefined : error };
    },
  };
}

export function codexHarness(options: CodexOptions = {}) {
  const isolate = options.isolate ?? true;
  return nativeHarness(
    {
      id: "codex",
      name: "Codex CLI",
      executable: "codex",
      capabilities: { readOnly: "enforced", write: true, streaming: true, costReport: false, modelSelect: true },
      authEnv: [/^OPENAI_/, /^CODEX_/],
      build(req, ctx) {
        const flags = [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--ephemeral",
          "--color", "never",
          "-s", req.access === "read" ? "read-only" : "workspace-write",
          "-C", req.cwd,
          "-o", ctx.outputFile,
        ];
        if (isolate) flags.push("--ignore-user-config", "--ignore-rules");
        if (req.model) flags.push("-m", req.model);
        if (req.effort) flags.push("-c", `model_reasoning_effort="${req.effort}"`);
        // "-" reads the prompt from stdin
        return { flags, promptArg: "-", stdin: req.prompt };
      },
      parser: codexParser,
    },
    options,
  );
}
