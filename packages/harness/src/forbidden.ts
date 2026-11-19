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
const READ_FORBIDDEN = [/workspace-write/, /acceptEdits/, /^--add-dir$/, /fs_write/, /execute_bash/, /^--permission-mode$/];

export class ForbiddenFlagError extends Error {
  constructor(readonly flag: string) {
    super(`refusing to run with flag ${flag}`);
  }
}

/** Check the flags (not the prompt) of a command line. Throws on the first forbidden flag. */
export function assertSafeFlags(flags: readonly string[], access: Access): void {
  for (const raw of flags) {
    for (const part of raw.split("=")) {
      if (ALWAYS_FORBIDDEN.some((re) => re.test(part))) throw new ForbiddenFlagError(raw);
      if (access === "read" && READ_FORBIDDEN.some((re) => re.test(part))) throw new ForbiddenFlagError(raw);
    }
  }
}
