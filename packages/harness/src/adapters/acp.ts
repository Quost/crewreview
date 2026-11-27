import { readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolKind } from "@agentclientprotocol/sdk";
import { scrubEnv } from "../env.ts";
import { lastLines } from "../failure.ts";
import { versionOf, which } from "../process.ts";
import type { Access, Detection, Harness, HarnessEvent, RunRequest, RunResult, SignIn } from "../types.ts";
import { stallWatch } from "../stall.ts";

export interface AcpAgentConfig {
  id: string;
  name?: string;
  /** Command that starts the agent in ACP mode, e.g. ["gemini", "--experimental-acp"]. */
  command: string[];
  /** Env var name patterns the agent needs for its own login. */
  authEnv?: string[];
  envPassthrough?: string[];
  /** The command a person runs to sign the agent in, when there is one. */
  loginCommand?: string;
  /** The one command that installs it, when there is one. */
  installCommand?: string;
  /** Where to download or sign up for it, when there is one page to point at. */
  signupUrl?: string;
  /** How to tell whether it is signed in, for `doctor` and the app: a saved login, or a key of its own. */
  authCheck?: AcpAuthCheck;
}

/**
 * ACP agents keep their login where only they know: a file, or an env var with a key. Both are checked, cheapest first,
 * so a line in `doctor` says signed in or not instead of a dash. Nothing is run: `doctor` asks this twice per agent.
 */
export interface AcpAuthCheck {
  /** Env vars that hold a key the agent signs in with. */
  env?: string[];
  /** Files with a saved login. `~` is the home of the environment checked, and `$NAME` reads that variable. */
  files?: string[];
}

/** A saved login is a file with something in it: an empty one, or empty JSON, is an agent that was signed out. */
export async function hasSavedLogin(env: Record<string, string | undefined>, file: string): Promise<boolean> {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const path = file.replace(/^~/, home).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => env[name] ?? m);
  const text = (await readFile(path, "utf8").catch(() => undefined))?.trim();
  if (!text) return false;
  try {
    const saved: unknown = JSON.parse(text);
    return typeof saved === "object" && saved !== null && Object.keys(saved).length > 0;
  } catch {
    // Some agents save the token itself, not a JSON object.
    return true;
  }
}

const READ_KINDS: ReadonlySet<ToolKind> = new Set(["read", "search", "think"]);
const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(["read", "search", "think", "edit", "move"]);

function inside(root: string, path: string): boolean {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Decide a permission request the way a careful human would, without asking anyone. */
export function decidePermission(req: RequestPermissionRequest, access: Access, root: string): RequestPermissionResponse {
  const kind = (req.toolCall.kind ?? "other") as ToolKind;
  const allowed = access === "read" ? READ_KINDS : WRITE_KINDS;
  const paths = (req.toolCall.locations ?? []).map((l) => l.path);
  const ok = allowed.has(kind) && paths.every((p) => inside(root, p));
  const pick = (kinds: PermissionOption["kind"][]) => req.options.find((o) => kinds.includes(o.kind));
  const option = ok ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
  if (!option) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

/** A generic ACP client: any agent that speaks the Agent Client Protocol over stdio works. */
export function acpHarness(cfg: AcpAgentConfig): Harness {
  const exe = cfg.command[0]!;
  let detected: Detection | undefined;
  return {
    id: cfg.id,
    name: cfg.name ?? cfg.id,
    kind: "acp",
    // The app answers every permission request and serves file reads itself, so read mode is enforced by us.
    // The conformance canary still has to prove the agent doesn't write behind our back.
    capabilities: { readOnly: "enforced", write: true, streaming: true, costReport: false, modelSelect: false },

    ...(cfg.loginCommand ? { loginCommand: cfg.loginCommand } : {}),
    ...(cfg.installCommand ? { installCommand: cfg.installCommand } : {}),
    ...(cfg.signupUrl ? { signupUrl: cfg.signupUrl } : {}),
    ...(cfg.authCheck
      ? {
          async signIn(env: Record<string, string | undefined> = process.env): Promise<SignIn> {
            const auth = cfg.authCheck!;
            if (!which(exe, env.PATH ?? "")) return { state: "unknown", reason: "missing" };
            if ((auth.env ?? []).some((name) => env[name])) return { state: "yes" };
            for (const file of auth.files ?? []) if (await hasSavedLogin(env, file)) return { state: "yes" };
            return { state: "no" };
          },
        }
      : {}),

    async detect() {
      if (detected) return detected;
      const path = which(exe);
      if (!path) return (detected = { installed: false });
      return (detected = { installed: true, path, version: await versionOf(path) });
    },

    async run(req: RunRequest): Promise<RunResult> {
      const started = performance.now();
      const det = await this.detect();
      if (!det.installed || !det.path) {
        return { ok: false, text: "", exitCode: null, durationMs: 0, failure: "crash", error: `${exe} not found on PATH` };
      }
      const root = await realpath(req.cwd);
      const keep = (cfg.authEnv ?? []).map((p) => new RegExp(p));
      const proc = Bun.spawn([det.path, ...cfg.command.slice(1)], {
        cwd: root,
        env: scrubEnv(process.env, { keep, passthrough: cfg.envPassthrough }),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      let stderr = "";
      (async () => {
        const dec = new TextDecoder();
        for await (const c of proc.stderr as ReadableStream<Uint8Array>) stderr += dec.decode(c, { stream: true });
      })().catch(() => {});

      const output = new WritableStream<Uint8Array>({
        write(chunk) {
          proc.stdin.write(chunk);
          proc.stdin.flush();
        },
        close() {
          proc.stdin.end();
        },
      });
      const emit = (e: HarnessEvent) => req.onEvent?.(e);
      let text = "";
      const watch = stallWatch(req.stallMs ?? 0, 5000);

      const app = client({ name: "crewreview" })
        .onRequest(methods.client.session.requestPermission, ({ params }) => {
          watch.activity();
          const decision = decidePermission(params, req.access, root);
          emit({ type: "tool", text: `${params.toolCall.title ?? params.toolCall.kind ?? "tool"} → ${decision.outcome.outcome === "selected" && params.options.find((o) => o.optionId === (decision.outcome as { optionId: string }).optionId)?.kind.startsWith("allow") ? "allowed" : "denied"}`, at: Date.now() });
          return decision;
        })
        .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
          watch.activity();
          if (!inside(root, params.path)) throw RequestError.invalidParams({ path: params.path }, "outside the workspace");
          const full = await readFile(resolve(root, params.path), "utf8");
          if (params.line == null && params.limit == null) return { content: full };
          const lines = full.split("\n");
          const start = Math.max(0, (params.line ?? 1) - 1);
          return { content: lines.slice(start, params.limit == null ? undefined : start + params.limit).join("\n") };
        })
        .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
          watch.activity();
          if (req.access !== "write" || !inside(root, params.path)) {
            throw RequestError.invalidParams({ path: params.path }, "writing is not allowed");
          }
          await writeFile(resolve(root, params.path), params.content, "utf8");
          emit({ type: "tool", text: `write ${params.path}`, at: Date.now() });
        })
        .onNotification(methods.client.session.update, ({ params }) => {
          watch.activity();
          const u = params.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            text += u.content.text;
            emit({ type: "text", text: u.content.text, at: Date.now() });
          } else if (u.sessionUpdate === "tool_call") {
            emit({ type: "tool", text: u.title ?? u.kind ?? "tool", at: Date.now() });
          }
        });

      let failure: RunResult["failure"];
      let error: string | undefined;
      const timer = setTimeout(() => {
        failure = "timeout";
        proc.kill();
      }, req.timeoutMs);
      const stall = req.stallMs
        ? setInterval(() => {
            if (watch.check()) {
              failure = "stalled";
              proc.kill();
            }
          }, 5000)
        : undefined;
      const onAbort = () => {
        failure = "aborted";
        proc.kill();
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await app.connectWith(ndJsonStream(output, proc.stdout as ReadableStream<Uint8Array>), async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: req.access === "write" }, terminal: false },
            clientInfo: { name: "crewreview", version: "0" },
          });
          const session = await agent.request(methods.agent.session.new, { cwd: root, mcpServers: [] });
          // Prefer a read-only mode when the agent offers one.
          const modes = session.modes?.availableModes ?? [];
          const readMode = req.access === "read" ? modes.find((m) => /plan|read|ask/i.test(`${m.id} ${m.name}`)) : undefined;
          if (readMode) await agent.request(methods.agent.session.setMode, { sessionId: session.sessionId, modeId: readMode.id });
          const r = await agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: req.prompt }],
          });
          if (r.stopReason === "refusal") {
            failure = "crash";
            error = "agent refused";
          }
        });
      } catch (e) {
        failure ??= "crash";
        error = e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(timer);
        if (stall) clearInterval(stall);
        req.signal?.removeEventListener("abort", onAbort);
        try {
          proc.kill();
        } catch {}
      }
      const exitCode = await proc.exited;
      const ok = failure === undefined && text.trim() !== "";
      return {
        ok,
        text: text.trim(),
        exitCode,
        durationMs: performance.now() - started,
        failure: ok ? undefined : (failure ?? "crash"),
        error: ok ? undefined : (error ?? (lastLines(stderr) || "empty answer")),
      };
    },
  };
}
