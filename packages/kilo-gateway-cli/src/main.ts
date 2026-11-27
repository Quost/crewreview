import { Command } from "commander";
import { GatewayClient } from "./gateway.ts";
import { StreamParser } from "./parser.ts";
import type { ChatMessage } from "./gateway.ts";

const program = new Command();

program
  .name("kilo-gateway")
  .description("Kilo Gateway CLI - programmatic access to Kilo free models")
  .version("0.1.0")
  .option("-p, --prompt <prompt>", "Prompt to send (alternatively pipe via stdin)")
  .option("-m, --model <model>", "Model to use (default: auto-free)", "auto-free")
  .option("--output-format <format>", "Output format: stream-json, json, text", "stream-json")
  .option("--verbose", "Verbose output to stderr")
  .option("--api-url <url>", "Kilo Gateway API URL (or set KILO_API_URL env)", "https://api.kilo.ai/v1")
  .option("--api-key <key>", "API key (or set KILO_API_KEY env)")
  .option("--temperature <temp>", "Temperature", "0.7")
  .option("--max-tokens <tokens>", "Max tokens", "4096")
  .option("--system <prompt>", "System prompt")
  .option("--no-stream", "Disable streaming")
  .parse(process.argv);

const options = program.opts();

async function main() {
  const prompt = options.prompt ?? (await readStdin());
  if (!prompt || !prompt.trim()) {
    console.error("Error: No prompt provided. Use -p/--prompt or pipe via stdin.");
    process.exit(1);
  }

  const apiKey = options.apiKey ?? process.env.KILO_API_KEY;
  const apiUrl = options.apiUrl ?? process.env.KILO_API_URL ?? "https://api.kilo.ai/v1";
  if (!apiKey) {
    console.error("Error: No API key provided. Use --api-key or set KILO_API_KEY environment variable.");
    process.exit(1);
  }

  const client = new GatewayClient({
    baseUrl: apiUrl,
    apiKey,
  });

  const parser = new StreamParser({
    outputFormat: options.outputFormat as "stream-json" | "json" | "text",
    verbose: options.verbose,
  });

  try {
    const messages: ChatMessage[] = [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      { role: "user" as const, content: prompt },
    ];
    await client.chatCompletion({
      model: options.model,
      messages,
      temperature: Number(options.temperature),
      maxTokens: Number(options.maxTokens),
      stream: !options.noStream,
      onEvent: (event) => parser.handleEvent(event),
    });
    parser.finish();
  } catch (error) {
    parser.handleError(error instanceof Error ? error : new Error(String(error)));
    parser.finish();
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

main();