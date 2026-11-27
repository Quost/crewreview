import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgent } from "../src/adapters/kiro.ts";
import { ACP_PRESETS, buildRegistry as registryOf } from "../src/index.ts";
import {
  allowableCommand,
  assertSafeFlags,
  claudeHarness,
  claudeParser,
  codexHarness,
  codexParser,
  customHarness,
  decidePermission,
  ForbiddenFlagError,
  kiroHarness,
  scrubEnv,
  type RunRequest,
} from "../src/index.ts";

const req = (access: "read" | "write", prompt = "review --yolo please"): RunRequest => ({
  prompt,
  cwd: "/tmp/job",
  access,
  timeoutMs: 1000,
  model: "m1",
  effort: "high",
});
const ctx = { executable: "/bin/x", outputFile: "/tmp/out.txt" };

describe("command lines", () => {
  test("read mode of every built-in passes the deny-list and locks tools", () => {
    const claude = claudeHarness().command(req("read"), ctx);
    expect(claude.argv).toContain("--tools=Read,Grep,Glob");
    expect(claude.argv).toContain("--safe-mode");
    expect(claude.argv).not.toContain("--permission-mode");
    expect(claude.stdin).toBe("review --yolo please");

    const codex = codexHarness().command(req("read"), ctx);
    expect(codex.argv.join(" ")).toContain("-s read-only");
    expect(codex.argv.join(" ")).toContain("--ignore-user-config");
    expect(codex.argv.at(-1)).toBe("-");

    const kiro = kiroHarness().command(req("read"), ctx);
    expect(kiro.argv).toContain("--trust-tools=fs_read,grep,glob");
    expect(kiro.argv).not.toContain("--trust-workspace");
    // The prompt may mention a forbidden flag: it is never checked as a flag.
    expect(kiro.argv.at(-1)).toBe("review --yolo please");
  });

  test("write mode opens edits but never the dangerous switches", () => {
    expect(claudeHarness().command(req("write"), ctx).argv).toContain("acceptEdits");
    expect(codexHarness().command(req("write"), ctx).argv.join(" ")).toContain("-s workspace-write");
    // Kiro's writes are never trusted by flag: that would trust them on every path. Its write agent allows the folder.
    const kiro = kiroHarness().command(req("write"), ctx).argv.join(" ");
    expect(kiro).toContain("--trust-tools=fs_read,grep,glob");
    expect(kiro).not.toContain("fs_write");
  });

  test("deny-list", () => {
    expect(() => assertSafeFlags(["--dangerously-skip-permissions"], "write")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["-s", "danger-full-access"], "write")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["--trust-all-tools"], "write")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["--permission-mode=bypassPermissions"], "write")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["-s", "workspace-write"], "read")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["--add-dir", "/"], "read")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["--trust-tools=fs_read,fs_write"], "read")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["--agent", "anything"], "read")).toThrow(ForbiddenFlagError);
    expect(() => assertSafeFlags(["-s", "workspace-write"], "write")).not.toThrow();
  });

  test("custom harness: placeholders, stdin, and the prompt must come last", () => {
    const h = customHarness({ id: "mine", read: ["mycli", "--cwd", "{cwd}", "--ask", "{prompt}"] });
    expect(h.command(req("read", "hi"), ctx).argv).toEqual(["/bin/x", "--cwd", "/tmp/job", "--ask", "hi"]);
    const s = customHarness({ id: "s", read: ["mycli", "--quiet"] });
    expect(s.command(req("read", "hi"), ctx)).toEqual({ argv: ["/bin/x", "--quiet"], stdin: "hi" });
    const bad = customHarness({ id: "b", read: ["mycli", "{prompt}", "--dangerously-skip-permissions"] });
    expect(() => bad.command(req("read"), ctx)).toThrow();
    const yolo = customHarness({ id: "y", read: ["mycli", "--yolo"] });
    expect(() => yolo.command(req("read"), ctx)).toThrow(ForbiddenFlagError);
  });
});

describe("env", () => {
  test("host tokens and secrets never reach the agent", () => {
    const env = scrubEnv(
      {
        PATH: "/bin",
        HOME: "/home/x",
        GH_TOKEN: "a",
        GITHUB_TOKEN: "b",
        GITLAB_TOKEN: "c",
        AWS_SECRET_ACCESS_KEY: "d",
        MY_SERVICE_PASSWORD: "e",
        ANTHROPIC_API_KEY: "f",
        SSH_AUTH_SOCK: "/tmp/agent",
        CUSTOM_VAR: "ok",
      },
      { keep: [/^ANTHROPIC_/], passthrough: ["MY_SERVICE_PASSWORD"] },
    );
    expect(Object.keys(env).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "CREWREVIEW_AGENT", "CUSTOM_VAR", "HOME", "MY_SERVICE_PASSWORD", "NO_COLOR", "PATH"].sort(),
    );
  });
});

describe("ACP permissions", () => {
  const options = [
    { optionId: "y", name: "Allow", kind: "allow_once" as const },
    { optionId: "n", name: "Reject", kind: "reject_once" as const },
  ];
  const ask = (kind: string, path = "/tmp/job/a.ts") =>
    ({ sessionId: "s", options, toolCall: { toolCallId: "t", title: kind, kind, locations: [{ path }] } }) as never;

  test("read mode allows reading inside the workspace only", () => {
    expect(decidePermission(ask("read"), "read", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "y" } });
    expect(decidePermission(ask("read", "/etc/passwd"), "read", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
    expect(decidePermission(ask("edit"), "read", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
    expect(decidePermission(ask("execute"), "read", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
  });

  test("write mode allows edits inside, never shell or network", () => {
    expect(decidePermission(ask("edit"), "write", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "y" } });
    expect(decidePermission(ask("edit", "/tmp/job/../x"), "write", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
    expect(decidePermission(ask("execute"), "write", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
    expect(decidePermission(ask("fetch"), "write", "/tmp/job")).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
  });
});

describe("failure classification", () => {
  test("expired sessions are a login problem, not a crash", async () => {
    const { classifyFailure } = await import("../src/failure.ts");
    const r = { exitCode: 1, stdout: "", stderr: "", timedOut: false, stalled: false, aborted: false, durationMs: 1 };
    expect(classifyFailure(r, "Failed to authenticate: OAuth session expired and could not be refreshed")).toBe("auth");
    expect(classifyFailure(r, "Claude AI usage limit reached")).toBe("quota");
    expect(classifyFailure(r, "segfault")).toBe("crash");
  });
});

describe("output parsers", () => {
  test("claude stream-json: final result, usage, cost and tool events", async () => {
    const p = claudeParser();
    const events: string[] = [];
    const emit = (e: { type: string; text: string }) => events.push(`${e.type}:${e.text}`);
    for (const l of [
      '{"type":"system","subtype":"init","model":"opus"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"head/a.ts"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"findings\\":[]}"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"findings\\":[]}","total_cost_usd":0.012,"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":5}}',
    ]) p.line(l, emit as never);
    const out = await p.finish("", "/nonexistent");
    expect(out).toEqual({ text: '{"findings":[]}', usage: { inputTokens: 100, outputTokens: 5, costUsd: 0.012 } });
    expect(events).toContain("tool:Read head/a.ts");
  });

  test("claude error result surfaces as an error", async () => {
    const p = claudeParser();
    p.line('{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached"}', () => {});
    const out = await p.finish("", "/nonexistent");
    expect(out.text).toBe("");
    expect(out.error).toContain("usage limit");
  });

  test("codex jsonl: last agent message and summed usage", async () => {
    const p = codexParser();
    for (const l of [
      '{"type":"thread.started"}',
      '{"type":"item.started","item":{"type":"command_execution","command":"rg foo"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":7}}',
    ]) p.line(l, () => {});
    expect(await p.finish("", "/nonexistent")).toEqual({ text: '{"ok":true}', usage: { inputTokens: 50, outputTokens: 7 }, error: undefined });
  });
});


test("known ACP agents are built in, and a config entry with the same id replaces one", () => {
  const ids = [...registryOf().keys()];
  expect(ids).toEqual(["claude", "codex", "kiro", "kilo-gateway", ...ACP_PRESETS.map((p) => p.id)]);
  expect(ACP_PRESETS.map((p) => p.command.join(" "))).toEqual(["agy acp", "opencode acp", "gemini --experimental-acp", "freebuff --acp"]);
  const custom = registryOf({ acp: [{ id: "agy", name: "My agy", command: ["/opt/agy", "acp"] }] });
  expect(custom.get("agy")?.name).toBe("My agy");
  expect([...custom.keys()].filter((k) => k === "agy")).toHaveLength(1);
});

describe("commands an agent may run", () => {
  test("only one plain command each: no chain, glob, redirection or substitution", () => {
    for (const ok of ["mix test", "bun run check", "./scripts/check.sh --fast", "npm run lint:ci"]) expect(allowableCommand(ok)).toBe(true);
    for (const bad of ["mix test && curl x", "rm -rf *", "echo $(id)", "a; b", "a | b", "a > b", "`id`", "", " mix test", "x".repeat(201)]) expect(allowableCommand(bad)).toBe(false);
  });

  test("Claude Code gets no shell, commands or not: acceptEdits would approve rm and mv by itself", () => {
    const w = claudeHarness().command({ ...req("write"), commands: ["mix test"] }, ctx).argv;
    expect(w).toContain("--tools=Read,Grep,Glob,Edit,Write");
    expect(w.join(" ")).not.toContain("Bash");
    expect(claudeHarness().capabilities.commands).toBeUndefined();
    expect(() => assertSafeFlags(["--allowedTools", "Bash(mix test)"], "read")).toThrow();
  });

  test("Kiro's write agent gets a shell held to those commands, each matched whole", () => {
    const agent = writeAgent("crewreview-write-x", ["/w/job"], ["mix test", "./check.sh", "a; b"]) as { tools: string[]; toolsSettings: { shell?: { allowedCommands: string[] } } };
    expect(agent.tools).toContain("shell");
    expect(agent.toolsSettings.shell?.allowedCommands).toEqual(["^mix test$", "^\\./check\\.sh$"]);
    const none = writeAgent("crewreview-write-x", ["/w/job"], ["a; b"]) as { tools: string[]; toolsSettings: { shell?: unknown } };
    expect(none.tools).not.toContain("shell");
    expect(none.toolsSettings.shell).toBeUndefined();
  });
});

describe("kiro writes", () => {
  test("the write agent trusts reads, allows writes only inside the folder, and has no shell or MCP", () => {
    const agent = writeAgent("crewreview-write-x", ["/w/job", "/private/w/job"]) as {
      name: string;
      tools: string[];
      allowedTools: string[];
      includeMcpJson: boolean;
      mcpServers: object;
      toolsSettings: { write: { allowedPaths: string[] } };
    };
    expect(agent.name).toBe("crewreview-write-x");
    expect(agent.tools.sort()).toEqual(["glob", "grep", "read", "write"]);
    expect(agent.allowedTools).not.toContain("write");
    expect(agent.includeMcpJson).toBe(false);
    expect(agent.mcpServers).toEqual({});
    expect(agent.toolsSettings.write.allowedPaths).toEqual(["/w/job", join("/w/job", "**"), "/private/w/job", join("/private/w/job", "**")]);
  });

  // A shell script stands in for kiro-cli, so this one needs a shell.
  test.skipIf(process.platform === "win32")("a write run gets that agent, removed after the run with the backup Kiro leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewreview-kiro-"));
    const agents = join(root, "agents");
    const work = join(root, "work");
    // A stand-in for kiro-cli that prints the agent it was given.
    const fake = join(root, "kiro-cli");
    // Like Kiro, it rewrites the agent and keeps a backup.
    await writeFile(fake, `#!/bin/sh\nwhile [ "$1" != "--agent" ] && [ $# -gt 0 ]; do shift; done\ncp "${agents}/$2.json" "${agents}/$2.json.bak"\ncat "${agents}/$2.json"\n`);
    await chmod(fake, 0o755);
    await mkdir(work);
    const kiro = kiroHarness({ executable: fake, agentsDir: agents });
    const r = await kiro.run({ prompt: "fix it", cwd: work, access: "write", timeoutMs: 10_000 });
    expect(r.ok).toBe(true);
    const agent = JSON.parse(r.text);
    expect(agent.allowedTools).not.toContain("write");
    expect(agent.tools).not.toContain("shell");
    expect(agent.includeMcpJson).toBe(false);
    const allowed: string[] = agent.toolsSettings.write.allowedPaths;
    expect(allowed).toContain(join(work, "**"));
    expect(allowed.every((p) => p.endsWith("/work") || p.endsWith("/work/**"))).toBe(true);
    expect(await readdir(agents)).toEqual([]);
    // Reading needs no agent at all.
    const read = await kiro.run({ prompt: "review", cwd: work, access: "read", timeoutMs: 10_000 });
    expect(read.ok).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a run that may execute the project's checks keeps no secret in its environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "crewreview-kiro-env-"));
    const agents = join(root, "agents");
    const work = join(root, "work");
    const fake = join(root, "kiro-cli");
    await writeFile(fake, `#!/bin/sh\nenv\n`);
    await chmod(fake, 0o755);
    await mkdir(work);
    const kiro = kiroHarness({ executable: fake, agentsDir: agents });
    const saved = { k: process.env.KIRO_API_KEY, g: process.env.GH_TOKEN };
    process.env.KIRO_API_KEY = "kiro-secret";
    process.env.GH_TOKEN = "gh-secret";
    try {
      const plain = await kiro.run({ prompt: "fix it", cwd: work, access: "write", timeoutMs: 10_000 });
      expect(plain.text).toContain("KIRO_API_KEY=kiro-secret");
      const checks = await kiro.run({ prompt: "fix it", cwd: work, access: "write", timeoutMs: 10_000, commands: ["mix test"] });
      expect(checks.text).not.toContain("kiro-secret");
      expect(checks.text).not.toContain("gh-secret");
    } finally {
      process.env.KIRO_API_KEY = saved.k;
      process.env.GH_TOKEN = saved.g;
      if (saved.k === undefined) delete process.env.KIRO_API_KEY;
      if (saved.g === undefined) delete process.env.GH_TOKEN;
    }
  });
});
