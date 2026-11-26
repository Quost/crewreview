import { stallWatch } from "./stall.ts";
export interface ProcessOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  stallMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stalled: boolean;
  aborted: boolean;
  durationMs: number;
  spawnError?: string;
}

const KILL_GRACE_MS = 3000;

async function pump(stream: ReadableStream<Uint8Array>, onChunk: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) onChunk(decoder.decode(chunk, { stream: true }));
  const rest = decoder.decode();
  if (rest) onChunk(rest);
}

/** Run a command, capture its output, and stop it on timeout, stall or abort. Never throws. */
export async function runProcess(o: ProcessOptions): Promise<ProcessResult> {
  const started = performance.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(o.argv, {
      cwd: o.cwd,
      env: o.env,
      stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return {
      exitCode: null, stdout: "", stderr: "", timedOut: false, stalled: false, aborted: false,
      durationMs: performance.now() - started, spawnError: e instanceof Error ? e.message : String(e),
    };
  }

  let stdout = "";
  let stderr = "";
  let pending = "";
  const tickMs = o.stallMs ? Math.min(o.stallMs, 5000) : 5000;
  const watch = stallWatch(o.stallMs ?? 0, tickMs);
  let timedOut = false;
  let stalled = false;
  let aborted = false;

  const stop = () => {
    try {
      proc.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, KILL_GRACE_MS).unref?.();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, o.timeoutMs);
  const stallTimer = o.stallMs
    ? setInterval(() => {
        if (watch.check()) {
          stalled = true;
          stop();
        }
      }, tickMs)
    : undefined;
  const onAbort = () => {
    aborted = true;
    stop();
  };
  o.signal?.addEventListener("abort", onAbort, { once: true });

  const out = pump(proc.stdout as ReadableStream<Uint8Array>, (text) => {
    watch.activity();
    stdout += text;
    if (!o.onStdoutLine) return;
    pending += text;
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      o.onStdoutLine(pending.slice(0, nl).replace(/\r$/, ""));
      pending = pending.slice(nl + 1);
    }
  });
  const err = pump(proc.stderr as ReadableStream<Uint8Array>, (text) => {
    watch.activity();
    stderr += text;
    o.onStderr?.(text);
  });

  const exitCode = await proc.exited;
  await Promise.allSettled([out, err]);
  if (pending && o.onStdoutLine) o.onStdoutLine(pending);
  clearTimeout(timer);
  if (stallTimer) clearInterval(stallTimer);
  o.signal?.removeEventListener("abort", onAbort);

  return { exitCode, stdout, stderr, timedOut, stalled, aborted, durationMs: performance.now() - started };
}

/** Find an executable on PATH. */
/** Where `name` is on this PATH, or on another one (the PATH a background service starts with). */
/**
 * Find an executable on PATH. Always the current PATH: Bun.which alone uses the one the process started with, and the
 * desktop app sets a fuller one later (an app opened from the Dock starts with a bare PATH).
 */
export function which(name: string, path: string = process.env.PATH ?? ""): string | undefined {
  return Bun.which(name, { PATH: path }) ?? undefined;
}

/** First line of `<exe> --version`, or undefined. */
export async function versionOf(executable: string, args: string[] = ["--version"]): Promise<string | undefined> {
  const r = await runProcess({ argv: [executable, ...args], cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" } as Record<string, string>, timeoutMs: 15000 });
  if (r.exitCode !== 0) return undefined;
  const line = (r.stdout || r.stderr).trim().split("\n")[0]?.trim();
  return line || undefined;
}
