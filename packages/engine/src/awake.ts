import { which } from "@crewreview/harness";

/**
 * Keeps the computer from going to sleep while the crew works, so a review or an answer isn't cut off halfway. The
 * screen still turns off and locks as usual. Each system's own tool holds the request, tied to this process: if the
 * daemon dies, the request goes with it.
 */
export interface KeepAwake {
  /** Ask the system to stay awake; calling it again while on does nothing. */
  on(): void;
  /** Let the system sleep again. */
  off(): void;
  readonly active: boolean;
}

/** The command that holds the system awake until it is killed or `pid` exits, or undefined where there is none. */
export function awakeCommand(platform: string, pid: number, find: (name: string) => string | undefined = (n) => which(n)): string[] | undefined {
  if (platform === "darwin") {
    const exe = find("caffeinate");
    // -i: no idle sleep (the display may still sleep); -w: until this process ends.
    return exe ? [exe, "-i", "-w", String(pid)] : undefined;
  }
  if (platform === "linux") {
    const inhibit = find("systemd-inhibit");
    const tail = find("tail");
    return inhibit && tail ? [inhibit, "--what=idle:sleep", "--who=Crewreview", "--why=Reviewing pull requests", "--mode=block", tail, `--pid=${pid}`, "-f", "/dev/null"] : undefined;
  }
  if (platform === "win32") {
    const ps = find("powershell");
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this PowerShell thread until the daemon exits or it is killed.
    const script = `Add-Type -Name Power -Namespace Crewreview -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [Crewreview.Power]::SetThreadExecutionState(0x80000001) | Out-Null; Wait-Process -Id ${pid}`;
    return ps ? [ps, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] : undefined;
  }
  return undefined;
}

export function keepAwake(
  o: { enabled: boolean; platform?: string; pid?: number; find?: (name: string) => string | undefined; spawn?: (argv: string[]) => { kill(): void } } = { enabled: true },
): KeepAwake {
  const argv = o.enabled ? awakeCommand(o.platform ?? process.platform, o.pid ?? process.pid, o.find) : undefined;
  const spawn = o.spawn ?? ((a: string[]) => Bun.spawn(a, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true }));
  let proc: { kill(): void } | undefined;
  return {
    on() {
      if (proc || !argv) return;
      try {
        proc = spawn(argv);
      } catch {
        proc = undefined;
      }
    },
    off() {
      proc?.kill();
      proc = undefined;
    },
    get active() {
      return proc !== undefined;
    },
  };
}
