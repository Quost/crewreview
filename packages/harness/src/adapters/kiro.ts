import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { allowableCommand } from "../forbidden.ts";
import { nativeHarness, textParser, type NativeOptions } from "../native.ts";
import type { RunRequest } from "../types.ts";

export interface KiroOptions extends NativeOptions {
  /** Where Kiro looks for agents by name. Tests point it elsewhere. */
  agentsDir?: string;
}

/** A path Kiro reads as a glob: refuse one that would mean more than itself. */
const GLOB = /[*?[\]{}]/;

/**
 * The agent a write run uses: Kiro may read anywhere it's allowed to, but it writes, without asking, only inside the
 * folder it works in. Writing anywhere else needs an approval nobody can give without a terminal, so it's denied.
 * `--trust-tools=fs_write` would trust writes on every path, outside the folder too.
 */
export function writeAgent(name: string, folders: readonly string[], commands: readonly string[] = []): object {
  const allowed = commands.filter(allowableCommand);
  return {
    name,
    description: "Crewreview: writes only inside the folder it works in. Made for one run and removed after it.",
    prompt: null,
    mcpServers: {},
    tools: ["read", "write", "grep", "glob", ...(allowed.length ? ["shell"] : [])],
    toolAliases: {},
    allowedTools: ["read", "grep", "glob"],
    resources: [],
    // Each command matches whole (Kiro reads these as anchored patterns, and splits `;`, `&&` and `|` to check each
    // part), so only the project's checks run. Anything else needs an approval nobody gives: it's denied.
    toolsSettings: {
      write: { allowedPaths: folders.flatMap((f) => [f, join(f, "**")]) },
      ...(allowed.length ? { shell: { allowedCommands: allowed.map((c) => `^${c.replace(/[.+()[\]{}^$|?*\\]/g, "\\$&")}$`) } } : {}),
    },
    includeMcpJson: false,
    model: null,
  };
}

/**
 * Kiro CLI without a TTY. Only the listed tools are trusted; anything else is denied because nobody can approve it.
 * `--trust-workspace` is never passed: it would load hooks and agents from the reviewed folder.
 */
export function kiroHarness(options: KiroOptions = {}) {
  const agentsDir = options.agentsDir ?? join(homedir(), ".kiro", "agents");
  return nativeHarness(
    {
      id: "kiro",
      name: "Kiro CLI",
      executable: "kiro-cli",
      capabilities: { readOnly: "enforced", write: true, streaming: false, costReport: false, modelSelect: true, commands: true },
      authEnv: [/^KIRO_/],
      signInArgs: ["whoami"],
      loginCommand: "kiro-cli login",
      build(req) {
        // Writes are never trusted by flag: the agent from prepare() allows them inside the folder only.
        const flags = ["chat", "--no-interactive", "--trust-tools=fs_read,grep,glob", "--wrap", "never"];
        if (req.model) flags.push("--model", req.model);
        if (req.effort) flags.push("--effort", req.effort);
        return { flags, promptArg: req.prompt };
      },
      async prepare(req: RunRequest) {
        if (req.access !== "write") return { flags: [], cleanup: async () => {} };
        // macOS reaches temporary folders through a link (/var is /private/var): allow both spellings.
        const folders = [...new Set([req.cwd, await realpath(req.cwd)])];
        if (folders.some((f) => GLOB.test(f))) throw new Error(`the folder's path has glob characters: ${req.cwd}`);
        const name = `crewreview-write-${randomUUID()}`;
        const file = join(agentsDir, `${name}.json`);
        await mkdir(agentsDir, { recursive: true });
        await writeFile(file, JSON.stringify(writeAgent(name, folders, req.commands), null, 2) + "\n", { mode: 0o600 });
        // Kiro may rewrite the file to its newer format and keep a .bak beside it: both go.
        const cleanup = async () => {
          const left = (await readdir(agentsDir).catch(() => [])).filter((f) => f.startsWith(`${name}.`));
          await Promise.all(left.map((f) => rm(join(agentsDir, f), { force: true })));
        };
        return { flags: ["--agent", name], cleanup };
      },
      parser: textParser,
    },
    options,
  );
}
