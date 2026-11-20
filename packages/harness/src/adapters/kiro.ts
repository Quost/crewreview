import { nativeHarness, textParser, type NativeOptions } from "../native.ts";

/**
 * Kiro CLI without a TTY. Only the listed tools are trusted; anything else is denied because nobody can approve it.
 * `--trust-workspace` is never passed: it would load hooks and agents from the reviewed folder.
 */
export function kiroHarness(options: NativeOptions = {}) {
  return nativeHarness(
    {
      id: "kiro",
      name: "Kiro CLI",
      executable: "kiro-cli",
      capabilities: { readOnly: "enforced", write: true, streaming: false, costReport: false, modelSelect: true },
      authEnv: [/^KIRO_/],
      signInArgs: ["whoami"],
      loginCommand: "kiro-cli login",
      build(req) {
        const tools = req.access === "read" ? "fs_read,grep,glob" : "fs_read,fs_write,grep,glob";
        const flags = ["chat", "--no-interactive", `--trust-tools=${tools}`, "--wrap", "never"];
        if (req.model) flags.push("--model", req.model);
        if (req.effort) flags.push("--effort", req.effort);
        return { flags, promptArg: req.prompt };
      },
      parser: textParser,
    },
    options,
  );
}
