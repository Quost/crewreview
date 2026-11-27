import type { StreamEvent, Usage } from "./gateway.ts";

export interface StreamParserOptions {
  outputFormat: "stream-json" | "json" | "text";
  verbose: boolean;
}

export class StreamParser {
  private options: StreamParserOptions;
  private hasOutput = false;
  private finalUsage?: Usage;
  private finalError?: string;

  constructor(options: StreamParserOptions) {
    this.options = options;
  }

  handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case "start":
        if (this.options.outputFormat === "stream-json") {
          this.emit({ type: "status", text: `model ${event.model}`, at: event.timestamp });
        } else if (this.options.verbose) {
          console.error(`[kilo-gateway] Model: ${event.model}`);
        }
        break;

      case "text":
        if (this.options.outputFormat === "stream-json") {
          this.emit({ type: "text", text: event.text, at: event.timestamp });
        } else if (this.options.outputFormat === "text") {
          process.stdout.write(event.text);
        }
        this.hasOutput = true;
        break;

      case "tool_call":
        if (this.options.outputFormat === "stream-json") {
          const target = event.toolCall.function.arguments;
          this.emit({
            type: "tool",
            text: `${event.toolCall.function.name} ${target}`,
            at: event.timestamp,
          });
        } else if (this.options.verbose) {
          console.error(`[kilo-gateway] Tool call: ${event.toolCall.function.name}`);
        }
        break;

      case "tool_result":
        if (this.options.verbose) {
          console.error(`[kilo-gateway] Tool result: ${event.toolCallId}`);
        }
        break;

      case "reasoning":
        if (this.options.outputFormat === "stream-json") {
          this.emit({ type: "reasoning", text: event.text, at: event.timestamp });
        }
        break;

      case "finish":
        this.finalUsage = event.usage;
        break;

      case "error":
        this.finalError = event.error;
        break;
    }
  }

  handleError(error: Error): void {
    this.finalError = error.message;
    if (this.options.outputFormat === "stream-json") {
      this.emit({ type: "error", error: error.message, at: Date.now() });
    } else {
      console.error(`[kilo-gateway] Error: ${error.message}`);
    }
  }

  finish(): void {
    if (this.options.outputFormat === "stream-json") {
      const usage = this.finalUsage;
      this.emit({
        type: "result",
        text: this.finalError ?? "",
        usage: usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costUsd: usage.costUsd,
            }
          : undefined,
        isError: !!this.finalError,
        at: Date.now(),
      });
    } else if (this.options.outputFormat === "json") {
      const result = {
        text: this.hasOutput ? "" : (this.finalError ?? ""),
        usage: this.finalUsage
          ? {
              inputTokens: this.finalUsage.inputTokens,
              outputTokens: this.finalUsage.outputTokens,
              costUsd: this.finalUsage.costUsd,
            }
          : undefined,
        error: this.finalError,
      };
      console.log(JSON.stringify(result));
    }
  }

  private emit(event: Record<string, unknown>): void {
    console.log(JSON.stringify(event));
  }
}