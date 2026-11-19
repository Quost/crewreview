import { acquireLock, compareVersions, ConformanceStore, CrewDaemon, dashboardUrl, fetchVerified, isCompiledBinary, latestRelease, LockedError, loadRepos, managedByDesktop, readApiInfo, registryFor, replaceBinary, reposFile, startApi, type ApiInfo } from "@crewreview/engine";
import { repoRef, resolveToken } from "@crewreview/hosts";
import { templates } from "@crewreview/i18n";
import dashboard from "../../../web/index.html";
import { openStore, type Ctx } from "../ctx.ts";
import { logEvent } from "./review.ts";

const pickInfo = ({ url, port, token, pid, version }: ApiInfo): ApiInfo => ({ url, port, token, pid, version });

/** Open a URL in the default browser, on any system. */
export async function openBrowser(url: string): Promise<boolean> {
  const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

export interface DaemonArgs {
  /** Keep cycling (run) or do one pass (once). */
  loop: boolean;
  /** Serve the dashboard. */
  ui: boolean;
  /** Open the dashboard in the browser once it's up. */
  open: boolean;
  port?: number;
  /**
   * Started by the desktop app: talk to it in JSON lines on stdout, leave updates to the app, and stop when the app
   * closes our stdin (which also happens if the app crashes).
   */
  desktop?: boolean;
}

/** One message to the desktop app. The protocol is documented in apps/desktop/README.md. */
export type DesktopMessage =
  | { strings: Record<string, string>; locale: string; updateCheck: boolean }
  | { ready: ApiInfo }
  | { attach: ApiInfo }
  | { error: string };

function tellDesktop(m: DesktopMessage): void {
  process.stdout.write(`${JSON.stringify(m)}\n`);
}

export async function daemon(c: Ctx, a: DaemonArgs): Promise<number> {
  const { t } = c;
  if (a.desktop) tellDesktop({ strings: templates(t.locale, "desktop."), locale: t.locale, updateCheck: c.config.updates.check });
  const repos = await loadRepos(reposFile(c.dirs));
  const watched = repos.filter((r) => r.review.mode !== "off" || r.attend.mode !== "off");
  if (!a.loop && watched.length === 0) return (c.out(t.t("repo.none")), 0);
  let release: () => Promise<void>;
  try {
    release = await acquireLock(c.dirs.state);
  } catch (e) {
    if (!(e instanceof LockedError)) throw e;
    if (a.desktop) {
      // A service (or a terminal) already runs the crew: the app shows that one instead of starting another.
      const info = await readApiInfo(c.dirs.state);
      if (info) return (tellDesktop({ attach: pickInfo(info) }), 0);
      return (tellDesktop({ error: t.t("desktop.busy") }), 2);
    }
    return (c.err(t.t("error.locked", { pid: e.pid })), 2);
  }
  const store = openStore(c);
  store.recoverInterrupted();
  const source = async () => ({ token: (await resolveToken(repoRef("github", "github.com", "Quost/crewreview")))?.token, channel: c.config.updates.channel });
  const updater = isCompiledBinary() && !a.desktop && !managedByDesktop()
    ? {
        async check() {
          const r = await latestRelease(await source());
          return r && compareVersions(r.version, c.version) > 0 ? r.version : undefined;
        },
        async install() {
          const s = await source();
          const r = await latestRelease(s);
          if (r) await replaceBinary(process.execPath, await fetchVerified(r, s));
        },
      }
    : undefined;
  const crew = new CrewDaemon({ dirs: c.dirs, config: c.config, version: c.version, ui: t, store, conformance: ConformanceStore.in(c.dirs.state), registry: registryFor(c.config), configPath: c.configPath, updater });
  const off = crew.subscribe((e) => {
    if (e.type === "log") logEvent(c, e.entry.event);
  });
  const stop = new AbortController();
  const onSignal = () => {
    if (stop.signal.aborted) process.exit(130);
    c.err(t.t("run.stopping"));
    stop.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (a.desktop) {
    void (async () => {
      try {
        for await (const _ of Bun.stdin.stream());
      } catch {}
      if (!stop.signal.aborted) stop.abort();
    })();
  }
  let server: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    if ((a.ui || a.desktop) && a.loop) {
      server = await startApi({ crew, page: dashboard, port: a.port, stateDir: c.dirs.state });
      c.err(t.t("run.dashboard", { url: server.url }));
      if (a.desktop) tellDesktop({ ready: pickInfo(server) });
      else if (a.open) await openBrowser(dashboardUrl(server));
    }
    if (a.loop) {
      c.err(t.t("run.started", { count: watched.length }));
      // After a self-update, exit non-zero so launchd/systemd start the new binary.
      if ((await crew.loop(stop.signal)) === "restart") return 75;
    } else {
      await crew.cycle(stop.signal);
    }
    return 0;
  } finally {
    off();
    await server?.stop();
    store.close();
    await release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** `crewreview ui`: open the running daemon's dashboard, or start the daemon with it. */
export async function ui(c: Ctx, port?: number): Promise<number> {
  const info = await readApiInfo(c.dirs.state);
  if (info) {
    const url = dashboardUrl(info);
    if (!(await openBrowser(url))) c.out(url);
    else c.out(c.t.t("run.dashboard", { url: info.url }));
    return 0;
  }
  return daemon(c, { loop: true, ui: true, open: true, port });
}
