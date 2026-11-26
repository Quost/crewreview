import type { Access } from "./types.ts";

/** Never on any command line Crewreview builds: these switch off the harness's own safety. */
const ALWAYS_FORBIDDEN = [
  /^--dangerously/,
  /^--yolo$/,
  /^--trust-all-tools$/,
  /^-a$/,
  /bypassPermissions/,
  /danger-full-access/,
  /^--trust-workspace$/,
  /^--approve-for-me$/,
  /^--allow-all-tools$/,
  /^--full-auto$/,
];

/** Also forbidden in read mode: these grant write access or widen what the agent can reach. */
const READ_FORBIDDEN = [/workspace-write/, /acceptEdits/, /^--add-dir$/, /fs_write/, /execute_bash/, /^--permission-mode$/, /^--agent$/, /^Bash/, /^--allowedTools$/];

export class ForbiddenFlagError extends Error {
  constructor(readonly flag: string) {
    super(`refusing to run with flag ${flag}`);
  }
}

/** Check the flags (not the prompt) of a command line. Throws on the first forbidden flag. */
/**
 * A command the agent may be allowed to run: one plain command, no shell syntax, so the harness's exact match can't
 * be widened. A list entry with a glob or a chain is left out (Crewreview still runs it itself, after the agent).
 */
export function allowableCommand(command: string): boolean {
  return command.length > 0 && command.length <= 200 && /^[A-Za-z0-9_./:=@+,% -]+$/.test(command) && !/^\s|\s$/.test(command);
}

export function assertSafeFlags(flags: readonly string[], access: Access): void {
  for (const raw of flags) {
    for (const part of raw.split("=")) {
      if (ALWAYS_FORBIDDEN.some((re) => re.test(part))) throw new ForbiddenFlagError(raw);
      if (access === "read" && READ_FORBIDDEN.some((re) => re.test(part))) throw new ForbiddenFlagError(raw);
    }
  }
}
