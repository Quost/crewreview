/** Semantic versions, compared: > 0 when `a` is newer. A pre-release comes before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2) as [string, string | undefined];
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/**
 * This command is older than the service that runs the crew. Its answers (and the harness tests it records) would
 * describe a version that no longer runs.
 */
export function behindService(cli: string, service: string | undefined): boolean {
  return !!service && compareVersions(service, cli) > 0;
}

/** What `crewreview` the terminal finds first on its PATH. */
export type CommandOnPath =
  | { kind: "missing" }
  /** A symbolic link, and whether what it points to still exists. */
  | { kind: "link"; target: string; exists: boolean }
  /** A file of its own; `version` when it answered `--version` like Crewreview does. */
  | { kind: "file"; version?: string };

/**
 * Should the desktop app point the terminal's `crewreview` at its own, so one update covers both? Only a copy of
 * Crewreview of its own (the install script's) or a link to an app that moved or is gone: a link to somewhere else
 * belongs to a package manager, and an empty PATH stays as you left it.
 */
export function shouldLinkCommand(found: CommandOnPath, self: string): boolean {
  if (found.kind === "missing") return false;
  if (found.kind === "file") return found.version !== undefined;
  if (found.target === self) return false;
  return !found.exists || /\.app\/Contents\/MacOS\/crewreview$/.test(found.target);
}
