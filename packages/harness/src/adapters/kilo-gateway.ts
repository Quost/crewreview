import { nativeHarness, type NativeOptions, type StreamParser, type ParsedOutput } from "../native.ts";
import type { Usage } from "@crewreview/core";

export function kiloGatewayParser(): StreamParser {
  let finalResult: ParsedOutput | undefined;
  let lastText = "";
  let buffer = "";

  return {
    line(line, emit) {
      buffer += line;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const event = JSON.parse(l);
          if (event.type === "status" && event.text) {
            emit({ type: "status", text: event.text, at: event.at ?? Date.now() });
          } else if (event.type === "text" && event.text) {
            lastText = event.text;
            emit({ type: "text", text: event.text, at: event.at ?? Date.now() });
          } else if (event.type === "tool" && event.text) {
            emit({ type: "tool", text: event.text, at: event.at ?? Date.now() });
          } else if (event.type === "reasoning" && event.text) {
            emit({ type: "text", text: `[reasoning] ${event.text}`, at: event.at ?? Date.now() });
          } else if (event.type === "result") {
            const usage: Usage | undefined = event.usage
              ? {
                  inputTokens: event.usage.inputTokens ?? 0,
                  outputTokens: event.usage.outputTokens ?? 0,
                  costUsd: event.usage.costUsd,
                }
              : undefined;
            finalResult = event.isError
              ? { text: "", usage, error: event.text || "unknown error" }
              : { text: lastText || event.text || "", usage };
          } else if (event.type === "error") {
            emit({ type: "stderr", text: event.error, at: event.at ?? Date.now() });
          }
        } catch {
          // Not JSON, could be raw text output
          emit({ type: "text", text: l, at: Date.now() });
        }
      }
    },
    async finish(stdout) {
      if (finalResult) return finalResult;
      // Fallback: if we got raw text output
      const text = (stdout + buffer).trim();
      return { text, error: text ? undefined : "no output" };
    },
  };
}

export function kiloGatewayHarness(options: NativeOptions = {}) {
  return nativeHarness(
    {
      id: "kilo-gateway",
      name: "Kilo Gateway",
      executable: "kilo-gateway",
      capabilities: {
        readOnly: "enforced",
        write: true,
        streaming: true,
        costReport: true,
        modelSelect: true,
      },
      authEnv: [/^KILO_/],
      signInArgs: ["--version"],
      loginCommand: "kilo-gateway --api-key \$KILO_API_KEY --prompt 'test' --no-stream",
      parseSignIn(stdout) {
        return { loggedIn: stdout.includes("model") || stdout.length > 10 };
      },
      build(req) {
        const flags = [
          "-p",
          req.prompt,
          "--model",
          req.model ?? "auto-free",
          "--output-format",
          "stream-json",
        ];
        if (req.effort) flags.push("--effort", req.effort);
        if (process.env.KILO_GATEWAY_VERBOSE) flags.push("--verbose");
        return { flags, stdin: undefined };
      },
      parser: kiloGatewayParser,
    },
    options,
  );
}