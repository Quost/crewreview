import { compareVersions, fetchVerified, installService, isCompiledBinary, latestRelease, managedByDesktop, replaceBinary, serviceSpec, serviceStatus, uninstallService, UpdateError } from "@crewreview/engine";
import { resolveToken, repoRef } from "@crewreview/hosts";
import type { Ctx } from "../ctx.ts";

export async function service(c: Ctx, sub: string | undefined): Promise<number> {
  const { t, style: st } = c;
  const spec = serviceSpec(c.dirs);
  if (sub === "install") {
    const r = await installService(spec);
    if (!r.ok) return (c.err(st.red(t.t("service.installFailed", { detail: r.detail ?? "?" }))), 1);
    c.out(st.green(t.t("service.installed", { name: spec.name })));
    if (r.file) c.out(st.dim(r.file));
    c.out(st.dim(t.t("service.logs", { path: spec.logFile })));
    if (process.platform === "linux") c.out(st.dim(t.t("service.lingerHint")));
    return 0;
  }
  if (sub === "uninstall") {
    c.out((await uninstallService(spec)) ? t.t("service.removed") : t.t("service.notInstalled"));
    return 0;
  }
  if (sub === undefined || sub === "status") {
    const s = await serviceStatus(spec);
    if (!s.installed) return (c.out(t.t("service.notInstalled")), 0);
    c.out(s.running ? st.green(t.t("service.running", { pid: s.pid ?? "?" })) : st.yellow(t.t("service.stopped")));
    if (s.file) c.out(st.dim(s.file));
    c.out(st.dim(t.t("service.logs", { path: spec.logFile })));
    return 0;
  }
  c.err(t.t("error.usage", { usage: "crewreview service [install | uninstall | status]" }));
  return 2;
}

async function releaseToken(): Promise<string | undefined> {
  // While the repository is private, the gh login reads its releases; once public, no token is needed.
  return (await resolveToken(repoRef("github", "github.com", "Quost/crewreview")))?.token;
}

export async function update(c: Ctx, checkOnly: boolean, channel: string | undefined): Promise<number> {
  const { t, style: st } = c;
  const source = { token: await releaseToken(), channel: channel === "beta" ? ("beta" as const) : ("stable" as const) };
  let release;
  try {
    release = await latestRelease(source);
  } catch (e) {
    return (c.err(st.red(t.t("update.failed", { error: (e as Error).message }))), 1);
  }
  if (!release) return (c.out(t.t("update.noRelease")), 0);
  if (compareVersions(release.version, c.version) <= 0) return (c.out(t.t("update.current", { version: c.version })), 0);
  c.out(t.t("update.available", { version: release.version, current: c.version }));
  if (checkOnly) return 0;
  if (!isCompiledBinary()) return (c.err(st.yellow(t.t("update.notCompiled"))), 1);
  if (managedByDesktop()) return (c.err(st.yellow(t.t("desktop.managedUpdate"))), 1);
  try {
    const bytes = await fetchVerified(release, source);
    await replaceBinary(process.execPath, bytes);
  } catch (e) {
    const msg = e instanceof UpdateError ? `${e.code}: ${e.message}` : (e as Error).message;
    return (c.err(st.red(t.t("update.failed", { error: msg }))), 1);
  }
  c.out(st.green(t.t("update.installed", { from: c.version, to: release.version })));
  c.out(st.dim(t.t("update.restart")));
  return 0;
}
