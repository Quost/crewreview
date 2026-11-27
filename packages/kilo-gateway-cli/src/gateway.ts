export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      toolCalls?: ToolCall[];
    };
    finishReason: string | null;
  }>;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finishReason: string;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd?: number;
  };
}

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
}

export type StreamEventHandler = (event: StreamEvent) => void;

export type StreamEvent =
  | { type: "start"; model: string; timestamp: number }
  | { type: "text"; text: string; timestamp: number }
  | { type: "tool_call"; toolCall: ToolCall; timestamp: number }
  | { type: "tool_result"; toolCallId: string; result: string; timestamp: number }
  | { type: "finish"; usage?: Usage; timestamp: number }
  | { type: "error"; error: string; timestamp: number }
  | { type: "reasoning"; text: string; timestamp: number };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export class GatewayClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  async chatCompletion(request: ChatCompletionRequest & { onEvent: StreamEventHandler }): Promise<void> {
    const { onEvent, ...body } = request;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
        "Accept": body.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kilo Gateway API error (${response.status}): ${errorText}`);
    }

    if (body.stream) {
      await this.handleStreamResponse(response, onEvent);
    } else {
      await this.handleNonStreamResponse(response, onEvent);
    }
  }

  private async handleStreamResponse(response: Response, onEvent: StreamEventHandler): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let model = "unknown";
    let hasStarted = false;

    onEvent({ type: "start", model, timestamp: Date.now() });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") {
            onEvent({ type: "finish", timestamp: Date.now() });
            return;
          }

          try {
            const chunk: ChatCompletionChunk = JSON.parse(data);
            if (!hasStarted) {
              model = chunk.model;
              hasStarted = true;
            }

            for (const choice of chunk.choices) {
              const delta = choice.delta;

              if (delta.content) {
                onEvent({ type: "text", text: delta.content, timestamp: Date.now() });
              }

              if (delta.toolCalls) {
                for (const toolCall of delta.toolCalls) {
                  onEvent({ type: "tool_call", toolCall, timestamp: Date.now() });
                }
              }

              if (choice.finishReason) {
                onEvent({ type: "finish", timestamp: Date.now() });
                return;
              }
            }
          } catch (e) {
            if (this.verbose) console.error(`Failed to parse chunk: ${data}`, e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    onEvent({ type: "finish", timestamp: Date.now() });
  }

  private async handleNonStreamResponse(response: Response, onEvent: StreamEventHandler): Promise<void> {
    const data = await response.json() as ChatCompletionResponse;
    const choice = data.choices[0];

    onEvent({ type: "start", model: data.model, timestamp: Date.now() });

    if (choice?.message?.content) {
      onEvent({ type: "text", text: choice.message.content, timestamp: Date.now() });
    }

    if (choice?.message?.toolCalls) {
      for (const toolCall of choice.message.toolCalls) {
        onEvent({ type: "tool_call", toolCall, timestamp: Date.now() });
      }
    }

    if (data.usage) {
      onEvent({
        type: "finish",
        usage: {
          inputTokens: data.usage.promptTokens,
          outputTokens: data.usage.completionTokens,
          costUsd: data.usage.costUsd,
        },
        timestamp: Date.now(),
      });
    } else {
      onEvent({ type: "finish", timestamp: Date.now() });
    }
  }

  private get verbose(): boolean {
    return process.env.KILO_GATEWAY_VERBOSE === "1";
  }
}