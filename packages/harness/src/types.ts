import type { Usage } from "@crewreview/core";

/** `read`: may look at files only. `write`: may also edit files inside the working directory. */
export type Access = "read" | "write";

export interface HarnessEvent {
  type: "text" | "tool" | "status" | "stderr";
  text: string;
  at: number;
}

export interface RunRequest {
  prompt: string;
  cwd: string;
  access: Access;
  model?: string;
  effort?: string;
  timeoutMs: number;
  /** Kill the run when it prints nothing for this long. */
  stallMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
}

export type FailureKind = "timeout" | "stalled" | "quota" | "auth" | "crash" | "aborted" | "unsupported";

export interface RunResult {
  ok: boolean;
  /** The agent's final answer. */
  text: string;
  exitCode: number | null;
  durationMs: number;
  usage?: Usage;
  failure?: FailureKind;
  error?: string;
}

export interface Detection {
  installed: boolean;
  path?: string;
  version?: string;
}

export interface Capabilities {
  /** `enforced`: the harness itself refuses writes and shell in read mode. `unsupported`: it can't be locked. */
  readOnly: "enforced" | "unsupported";
  write: boolean;
  streaming: boolean;
  costReport: boolean;
  modelSelect: boolean;
}

export type HarnessKind = "native" | "acp" | "custom";

export interface Harness {
  id: string;
  name: string;
  kind: HarnessKind;
  capabilities: Capabilities;
  detect(): Promise<Detection>;
  run(request: RunRequest): Promise<RunResult>;
}

/** Native adapters also expose their command line, so tests can check it for forbidden flags. */
export interface CommandHarness extends Harness {
  command(request: RunRequest, ctx: { executable: string; outputFile: string }): { argv: string[]; stdin?: string };
}
