import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SHELL_KEEP } from "./shell-env.ts";
import type { AppDirs } from "./paths.ts";

/** Start the daemon with your login session: launchd on macOS, systemd --user on Linux, a logon task on Windows. */

export interface ServiceSpec {
  /** launchd label, systemd unit name (without .service), Windows task name. */
  name: string;
  /** Full command line of the daemon. */
  program: string[];
  env: Record<string, string>;
  logFile: string;
}

export type ServicePlatform = "darwin" | "linux" | "win32";

/**
 * The daemon command: the compiled binary itself, or `bun <main.ts>` when running from source. A Crewreview home
 * other than the default gets its own service name, so a test install never replaces the real one.
 */
export function serviceSpec(dirs: AppDirs, env: Record<string, string | undefined> = process.env, execPath = process.execPath, script = process.argv[1]): ServiceSpec {
  const compiled = !/(^|[\\/])bun(\.exe)?$/i.test(execPath);
  const program = compiled ? [execPath, "run"] : [execPath, resolve(script ?? "apps/cli/src/main.ts"), "run"];
  const custom = env.CREWREVIEW_HOME;
  const suffix = custom ? `-${createHash("sha256").update(custom).digest("hex").slice(0, 8)}` : "";
  const keep: Record<string, string> = {};
  // A service starts with an almost empty environment: bring PATH (to find the harness CLIs and gh/glab), the few
  // settings Crewreview itself reads, and where the harnesses keep their login (the Claude desktop app, for one,
  // points Claude Code at its own folder). Tokens are never copied into service files.
  for (const k of SERVICE_KEEP) if (env[k]) keep[k] = env[k]!;
  return { name: `crewreview${suffix}`, program, env: keep, logFile: join(dirs.state, "daemon.log") };
}

/** The same variables the desktop app takes from your shell. */
const SERVICE_KEEP = SHELL_KEEP;

/** What every process gets from launchd, systemd --user or the Windows task scheduler, before the service file's own. */
const SESSION_VARS: Record<ServicePlatform, string[]> = {
  darwin: ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"],
  linux: ["HOME", "USER", "LOGNAME", "SHELL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"],
  win32: ["USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "ComSpec", "PATHEXT", "ProgramData", "ProgramFiles"],
};

/**
 * The environment the daemon would run with as a service, as near as it can be told from here: the session's own
 * variables plus what `service install` writes into the service file. `doctor` asks the harnesses about their login
 * with it, since a login that works in your terminal may not be visible to a service.
 */
export function serviceEnvironment(spec: ServiceSpec, env: Record<string, string | undefined> = process.env, platform: ServicePlatform = process.platform as ServicePlatform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SESSION_VARS[platform] ?? SESSION_VARS.linux) if (env[k]) out[k] = env[k]!;
  return { ...out, ...spec.env };
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdLabel(spec: ServiceSpec): string {
  return `dev.${spec.name.replace(/^crewreview/, "crewreview.daemon")}`;
}

export function launchdPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xml(launchdLabel(spec))}</string>
    <key>ProgramArguments</key>
    <array>
${spec.program.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>ProcessType</key><string>Background</string>
    <key>WorkingDirectory</key><string>${xml(homedir())}</string>
    <key>StandardOutPath</key><string>${xml(spec.logFile)}</string>
    <key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>
  </dict>
</plist>
`;
}

const quote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);

export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=Crewreview: AI code review crew
After=network-online.target

[Service]
ExecStart=${spec.program.map(quote).join(" ")}
Restart=on-failure
RestartSec=30
${Object.entries(spec.env)
  .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
  .join("\n")}
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`;
}

/** The command a Windows logon task runs. */
export function windowsTaskCommand(spec: ServiceSpec): string {
  return spec.program.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

export function serviceFile(spec: ServiceSpec, platform: ServicePlatform, home = homedir()): string | undefined {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${launchdLabel(spec)}.plist`);
  if (platform === "linux") return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user", `${spec.name}.service`);
  return undefined;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: `${out}${err}` };
  } catch (e) {
    return { code: 127, out: (e as Error).message };
  }
}

const uid = () => (process.getuid ? process.getuid() : 0);

export type ServiceState = { installed: false } | { installed: true; running: boolean; pid?: number; file?: string };

export async function installService(spec: ServiceSpec, platform: ServicePlatform = process.platform as ServicePlatform): Promise<{ ok: boolean; file?: string; detail?: string }> {
  await mkdir(dirname(spec.logFile), { recursive: true });
  if (platform === "darwin") {
    const file = serviceFile(spec, platform)!;
    await mkdir(dirname(file), { recursive: true });
    await run(["launchctl", "bootout", `gui/${uid()}/${launchdLabel(spec)}`]);
    await writeFile(file, launchdPlist(spec));
    const r = await run(["launchctl", "bootstrap", `gui/${uid()}`, file]);
    return { ok: r.code === 0, file, detail: r.code === 0 ? undefined : r.out.trim() };
  }
  if (platform === "linux") {
    const file = serviceFile(spec, platform)!;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, systemdUnit(spec));
    await run(["systemctl", "--user", "daemon-reload"]);
    const r = await run(["systemctl", "--user", "enable", "--now", `${spec.name}.service`]);
    return { ok: r.code === 0, file, detail: r.code === 0 ? undefined : r.out.trim() };
  }
  const r = await run(["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", spec.name, "/TR", windowsTaskCommand(spec)]);
  if (r.code === 0) await run(["schtasks", "/Run", "/TN", spec.name]);
  return { ok: r.code === 0, detail: r.code === 0 ? undefined : r.out.trim() };
}

export async function uninstallService(spec: ServiceSpec, platform: ServicePlatform = process.platform as ServicePlatform): Promise<boolean> {
  if (platform === "darwin") {
    await run(["launchctl", "bootout", `gui/${uid()}/${launchdLabel(spec)}`]);
    const file = serviceFile(spec, platform)!;
    const had = existsSync(file);
    await rm(file, { force: true });
    return had;
  }
  if (platform === "linux") {
    await run(["systemctl", "--user", "disable", "--now", `${spec.name}.service`]);
    const file = serviceFile(spec, platform)!;
    const had = existsSync(file);
    await rm(file, { force: true });
    await run(["systemctl", "--user", "daemon-reload"]);
    return had;
  }
  await run(["schtasks", "/End", "/TN", spec.name]);
  return (await run(["schtasks", "/Delete", "/F", "/TN", spec.name])).code === 0;
}

export async function serviceStatus(spec: ServiceSpec, platform: ServicePlatform = process.platform as ServicePlatform): Promise<ServiceState> {
  if (platform === "darwin") {
    const file = serviceFile(spec, platform)!;
    if (!existsSync(file)) return { installed: false };
    const r = await run(["launchctl", "print", `gui/${uid()}/${launchdLabel(spec)}`]);
    const pid = Number(/\bpid = (\d+)/.exec(r.out)?.[1]);
    return { installed: true, running: r.code === 0 && /state = running/.test(r.out), pid: pid || undefined, file };
  }
  if (platform === "linux") {
    const file = serviceFile(spec, platform)!;
    if (!existsSync(file)) return { installed: false };
    const r = await run(["systemctl", "--user", "show", `${spec.name}.service`, "--property=ActiveState,MainPID"]);
    const pid = Number(/MainPID=(\d+)/.exec(r.out)?.[1]);
    return { installed: true, running: /ActiveState=active/.test(r.out), pid: pid || undefined, file };
  }
  const r = await run(["schtasks", "/Query", "/TN", spec.name, "/FO", "LIST"]);
  if (r.code !== 0) return { installed: false };
  return { installed: true, running: /Running|Em execu|En ejecuci|Wird ausgef|正在运行/i.test(r.out) };
}
