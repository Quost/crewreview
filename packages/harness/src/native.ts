import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi, type Usage } from "@crewreview/core";
import { scrubEnv } from "./env.ts";
import { classifyFailure, lastLines } from "./failure.ts";
import { assertSafeFlags, ForbiddenFlagError } from "./forbidden.ts";
import { runProcess, versionOf, which } from "./process.ts";
import type { Capabilities, CommandHarness, Detection, HarnessEvent, RunRequest, RunResult, SignIn } from "./types.ts";

/** What a native adapter turns stdout into. */
export interface ParsedOutput {
  text: string;
  usage?: Usage;
  error?: string;
}

export interface StreamParser {
  line(line: string, emit: (e: HarnessEvent) => void): void;
  finish(stdout: string, outputFile: string): Promise<ParsedOutput>;
}

export interface NativeSpec {
  id: string;
  name: string;
  executable: string;
  capabilities: Capabilities;
  /** Env vars this harness needs for its own login. */
  authEnv: RegExp[];
  versionArgs?: string[];
  /** The harness's own "am I signed in" command: exit 0 means yes. */
  signInArgs?: string[];
  /** What to run to sign in, shown to people. */
  loginCommand?: string;
  /** Read more from that command's output: an explicit "no", and when the login expires. */
  parseSignIn?(stdout: string): { loggedIn?: boolean; expiresAt?: string };
  /** Flags first, then how the prompt goes in. The prompt is never checked against the flag deny-list. */
  build(req: RunRequest, ctx: { executable: string; outputFile: string }): { flags: string[]; promptArg?: string; stdin?: string };
  parser(): StreamParser;
}

export interface NativeOptions {
  /** Override the executable (path or name). */
  executable?: string;
  /** Env var names to pass through as they are. */
  envPassthrough?: string[];
}

export function textParser(): StreamParser {
  return {
    line() {},
    async finish(stdout) {
      return { text: stripAnsi(stdout).trim() };
    },
  };
}

export function nativeHarness(spec: NativeSpec, options: NativeOptions = {}): CommandHarness {
  const exeName = options.executable ?? spec.executable;
  let detected: Detection | undefined;

  const harness: CommandHarness = {
    id: spec.id,
    name: spec.name,
    kind: "native",
    capabilities: spec.capabilities,
    ...(spec.loginCommand ? { loginCommand: spec.loginCommand } : {}),

    async detect() {
      if (detected) return detected;
      const path = which(exeName);
      if (!path) return (detected = { installed: false });
      return (detected = { installed: true, path, version: await versionOf(path, spec.versionArgs) });
    },

    command(req, ctx) {
      const b = spec.build(req, ctx);
      assertSafeFlags(b.flags, req.access);
      return { argv: [ctx.executable, ...b.flags, ...(b.promptArg === undefined ? [] : [b.promptArg])], stdin: b.stdin };
    },

    async run(req): Promise<RunResult> {
      const started = performance.now();
      const det = await harness.detect();
      if (!det.installed || !det.path) {
        return { ok: false, text: "", exitCode: null, durationMs: 0, failure: "crash", error: `${exeName} not found on PATH` };
      }
      if (req.access === "write" && !spec.capabilities.write) {
        return { ok: false, text: "", exitCode: null, durationMs: 0, failure: "unsupported", error: `${spec.id} can't run in write mode` };
      }
      if (req.access === "read" && spec.capabilities.readOnly !== "enforced") {
        return { ok: false, text: "", exitCode: null, durationMs: 0, failure: "unsupported", error: `${spec.id} has no read-only lock` };
      }
      const scratch = await mkdtemp(join(tmpdir(), "crewreview-out-"));
      const outputFile = join(scratch, "last-message.txt");
      try {
        let cmd: { argv: string[]; stdin?: string };
        try {
          cmd = harness.command(req, { executable: det.path, outputFile });
        } catch (e) {
          if (e instanceof ForbiddenFlagError) return { ok: false, text: "", exitCode: null, durationMs: 0, failure: "unsupported", error: e.message };
          throw e;
        }
        const parser = spec.parser();
        const emit = (e: HarnessEvent) => req.onEvent?.(e);
        const r = await runProcess({
          argv: cmd.argv,
          cwd: req.cwd,
          env: scrubEnv(process.env, { keep: spec.authEnv, passthrough: options.envPassthrough }),
          stdin: cmd.stdin,
          timeoutMs: req.timeoutMs,
          stallMs: req.stallMs,
          signal: req.signal,
          onStdoutLine: (line) => parser.line(line, emit),
          onStderr: (chunk) => emit({ type: "stderr", text: chunk, at: Date.now() }),
        });
        const parsed = await parser.finish(r.stdout, outputFile);
        const failure = classifyFailure(r, parsed.error ? "" : parsed.text) ?? (parsed.error ? classifyFailure({ ...r, exitCode: 1 }, parsed.error) : undefined);
        const ok = failure === undefined && parsed.text !== "";
        return {
          ok,
          text: parsed.text,
          exitCode: r.exitCode,
          durationMs: performance.now() - started,
          usage: parsed.usage,
          failure: ok ? undefined : (failure ?? "crash"),
          error: ok ? undefined : (r.spawnError ?? parsed.error ?? (lastLines(r.stderr) || lastLines(r.stdout) || "empty answer")),
        };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
  if (spec.signInArgs) {
    const args = spec.signInArgs;
    harness.signIn = async (env = process.env): Promise<SignIn> => {
      const path = env === process.env ? (await harness.detect()).path : which(exeName, env.PATH ?? "");
      if (!path) return { state: "unknown", reason: "missing" };
      const r = await runProcess({ argv: [path, ...args], cwd: tmpdir(), env: scrubEnv(env, { keep: spec.authEnv, passthrough: options.envPassthrough }), timeoutMs: 20_000 });
      if (r.spawnError || r.timedOut) return { state: "unknown" };
      let parsed: { loggedIn?: boolean; expiresAt?: string } = {};
      try {
        parsed = spec.parseSignIn?.(r.stdout) ?? {};
      } catch {}
      const yes = r.exitCode === 0 && parsed.loggedIn !== false;
      return yes ? { state: "yes", ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}) } : { state: "no" };
    };
  }
  return harness;
}

export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
