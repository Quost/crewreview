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
  /**
   * Write runs only: the exact commands the agent may run in its folder (the project's checks), when the harness can
   * hold it to them. Nothing else runs; an empty or absent list means no shell at all.
   */
  commands?: readonly string[];
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
  /**
   * The harness can run `RunRequest.commands` and nothing else. Absent: it can't be held to a list, so it gets no
   * commands (Codex runs its own shell inside its sandbox either way).
   */
  commands?: boolean;
}

export type HarnessKind = "native" | "acp" | "custom";

/** Whether the harness's own login works: `yes`, `no`, or `unknown` when it couldn't be asked. */
export interface SignIn {
  state: "yes" | "no" | "unknown";
  /** `missing`: the executable isn't on that PATH at all. */
  reason?: "missing";
  /** When the login stops working, when the harness says (ISO time). */
  expiresAt?: string;
}

export interface Harness {
  id: string;
  name: string;
  kind: HarnessKind;
  capabilities: Capabilities;
  detect(): Promise<Detection>;
  run(request: RunRequest): Promise<RunResult>;
  /**
   * Ask the harness whether it is signed in, with the environment a run gets from `env` (default: this process).
   * Absent when the harness has no way to tell.
   */
  signIn?(env?: Record<string, string | undefined>): Promise<SignIn>;
  /** The command a person runs to sign this harness in, when there is one. */
  loginCommand?: string;
  /** The one command that installs it, when there is one. */
  installCommand?: string;
  /** Where to download or sign up for it, when there is one page to point at. */
  signupUrl?: string;
}

/** Native adapters also expose their command line, so tests can check it for forbidden flags. */
export interface CommandHarness extends Harness {
  command(request: RunRequest, ctx: { executable: string; outputFile: string; extraFlags?: string[] }): { argv: string[]; stdin?: string };
}
