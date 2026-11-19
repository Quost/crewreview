import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// Talks to `crewreview mcp` over stdio the way a harness does.
describe("MCP server", () => {
  test("initialize, list tools, call one, refuse an unknown tool", async () => {
    const home = await mkdtemp(join(tmpdir(), "crewreview-mcp-"));
    const main = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src", "main.ts");
    const proc = Bun.spawn([process.execPath, main, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, CREWREVIEW_HOME: home } });
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "crewreview_config", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } },
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
    ];
    proc.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const byId = new Map(out.trim().split("\n").map((l) => JSON.parse(l)).map((m) => [m.id, m]));
    expect(byId.get(1).result.serverInfo.name).toBe("crewreview");
    const names = byId.get(2).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("crewreview_review_local");
    // Approving, posting and pushing stay with the user.
    expect(names.some((n: string) => /approve|post|push|publish/.test(n))).toBe(false);
    expect(JSON.parse(byId.get(3).result.content[0].text).config).toContain(home);
    expect(byId.get(4).error.code).toBe(-32602);
    expect(byId.get(5).error.code).toBe(-32601);
    await rm(home, { recursive: true, force: true });
  }, 60_000);
});
