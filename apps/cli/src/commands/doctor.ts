import { arch, platform } from "node:os";
import { registryFor, reviewable, seatSpec, serviceEnvironment, serviceSpec } from "@crewreview/engine";
import { signedInHosts } from "@crewreview/hosts";
import { runConformance, runProcess, which, type SignIn } from "@crewreview/harness";
import { conformanceStore, table, type Ctx } from "../ctx.ts";

async function gitVersion(): Promise<string | undefined> {
  const r = await runProcess({ argv: ["git", "--version"], cwd: process.cwd(), env: process.env as Record<string, string>, timeoutMs: 10_000 });
  return r.exitCode === 0 ? r.stdout.trim().replace(/^git version /, "") : undefined;
}

export async function doctor(c: Ctx, conformance: boolean): Promise<number> {
  const { t, style: st } = c;
  const store = conformanceStore(c);
  const registry = registryFor(c.config);
  c.out(st.bold(`${t.t("doctor.title")}  ${st.dim(c.version)}`));
  c.out();
  c.out(st.bold(t.t("doctor.system")));
  c.out(`  ${platform()} ${arch()} · git ${(await gitVersion()) ?? st.red(t.t("doctor.missing"))}`);
  c.out(`  ${t.t("doctor.config").padEnd(8)} ${c.configPath}${c.configExists ? "" : st.dim(" (—)")}`);
  c.out(`  ${t.t("doctor.data").padEnd(8)} ${c.dirs.data}`);
  c.out();

  if (conformance) {
    for (const h of registry.values()) {
      if (!(await h.detect()).installed || h.capabilities.readOnly !== "enforced") continue;
      c.err(c.errStyle.dim(t.t("doctor.conformanceRunning", { name: h.id })));
      const r = await runConformance(h, { write: h.capabilities.write });
      await store.put(r);
      const detail = r.error ? c.errStyle.dim(` — ${r.failure ?? ""} ${r.error.split("\n")[0]}`) : "";
      c.err(t.t("doctor.conformanceResult", { name: h.id, structured: t.t(`check.${r.structured}`), readOnly: t.t(`check.${r.readOnly}`), seconds: Math.round(r.durationMs / 1000) }) + ` · ${t.t("doctor.col.write")} ${t.t(`check.${r.writeScope ?? "skipped"}`)}` + detail);
    }
    c.err();
  }

  c.out(st.bold(t.t("doctor.harnesses")));
  const rows: string[][] = [];
  const hints: string[] = [];
  let ready: string | undefined;
  // A login that works in this terminal may not reach the background service, which starts with a bare environment.
  const asService = serviceEnvironment(serviceSpec(c.dirs));
  const day = (iso: string) => new Date(iso).toLocaleDateString(t.locale, { month: "short", day: "numeric" });
  const loginCell = (s: SignIn | undefined) =>
    !s ? "—" : s.state === "yes" ? st.green(s.expiresAt ? `${t.t("doctor.yes")} · ${t.t("doctor.until", { date: day(s.expiresAt) })}` : t.t("doctor.yes")) : s.state === "no" ? st.yellow(t.t("doctor.no")) : s.reason === "missing" ? st.yellow(t.t("doctor.notOnPath")) : st.dim("?");
  for (const h of registry.values()) {
    const det = await h.detect();
    const [here, service] = det.installed && h.signIn ? await Promise.all([h.signIn(), h.signIn(asService)]) : [undefined, undefined];
    const login = h.loginCommand ?? "";
    if (here?.state === "no") hints.push(t.t("doctor.signInHint", { name: h.name, command: login }));
    else if (here?.state === "yes" && service && service.state !== "yes" && (service.state === "no" || service.reason === "missing"))
      hints.push(t.t("doctor.serviceHint", { name: h.name, why: t.t(service.state === "no" ? "doctor.why.notSignedIn" : "doctor.why.notOnPath") }));
    if (here?.expiresAt && Date.parse(here.expiresAt) - Date.now() < 3 * 86_400_000) {
      const days = Math.max(0, Math.round((Date.parse(here.expiresAt) - Date.now()) / 86_400_000));
      hints.push(t.t("doctor.expiresSoon", { name: h.name, when: new Intl.RelativeTimeFormat(t.locale, { numeric: "auto" }).format(days, "day"), command: login }));
    }
    const conf = det.installed ? await store.get(h.id, det.version) : undefined;
    const ro =
      h.capabilities.readOnly !== "enforced" ? t.t("doctor.no") : conf?.readOnly === "pass" ? t.t("doctor.verified") : conf?.readOnly === "fail" ? t.t("doctor.failedCheck") : t.t("doctor.byFlags");
    rows.push([
      h.id,
      det.installed ? t.t("doctor.installed") : t.t("doctor.notInstalled"),
      det.installed ? (det.version ?? "?").replace(/\s*\(.*\)$/, "").replace(/^[a-z-]+ /i, "") : "—",
      det.installed ? ro : "—",
      !h.capabilities.write ? t.t("doctor.no") : !det.installed ? "—" : conf?.writeScope === "pass" ? t.t("doctor.verified") : conf?.writeScope === "fail" ? t.t("doctor.failedCheck") : t.t("doctor.untested"),
      h.capabilities.costReport ? t.t("doctor.yes") : t.t("doctor.no"),
      det.installed ? loginCell(here) : "—",
      det.installed ? loginCell(service) : "—",
    ]);
    if (!ready && det.installed && here?.state !== "no" && (await reviewable(h, store)) === "ok") ready = h.id;
  }
  table(c, [t.t("doctor.col.harness"), t.t("doctor.col.status"), t.t("doctor.col.version"), t.t("doctor.col.readOnly"), t.t("doctor.col.write"), t.t("doctor.col.cost"), t.t("doctor.col.login"), t.t("doctor.col.service")], rows);
  for (const hint of hints) c.out(`  ${st.yellow("!")} ${hint}`);
  c.out();
  // The jobs [roles] routes through seats, and seats whose harness isn't here.
  const routed = (["review", "verify", "attend"] as const).filter((r) => c.config.roles[r]);
  if (routed.length) {
    c.out(st.bold(t.t("doctor.team")));
    for (const role of routed) {
      const route = c.config.roles[role]!;
      const seats = route.seats.map((id) => {
        const s = seatSpec(c.config, id);
        return `${id} (${[s.harness, s.model, s.effort].filter(Boolean).join(" · ")})`;
      });
      c.out(`  ${role.padEnd(8)} ${seats.join(" → ")}${route.seats.length > 1 ? st.dim(`  ${route.balance}`) : ""}`);
    }
    for (const id of new Set(routed.flatMap((r) => c.config.roles[r]!.seats))) {
      const h = registry.get(seatSpec(c.config, id).harness);
      if (!h || !(await h.detect()).installed) c.out(`  ${st.yellow("!")} ${t.t("doctor.seatMissing", { seat: id, harness: seatSpec(c.config, id).harness })}`);
    }
    c.out();
  }
  c.out(st.bold(t.t("doctor.hosts")));
  // The hosts each CLI holds a working login for. `glab auth status` fails when any configured host does (gitlab.com
  // with no login, say), so its exit code alone called a company GitLab login "not signed in".
  const hosts = await signedInHosts().catch(() => []);
  for (const [cli, kind] of [["gh", "github"], ["glab", "gitlab"]] as const) {
    const mine = hosts.filter((h) => h.kind === kind).map((h) => h.host);
    c.out(`  ${cli.padEnd(6)} ${!which(cli) ? st.dim(t.t("doctor.notInstalled")) : mine.length ? st.green(`${t.t("doctor.signedIn")}: ${mine.join(", ")}`) : st.yellow(t.t("doctor.notSignedIn"))}`);
  }
  c.out();
  if (!conformance) c.out(st.dim(t.t("doctor.conformanceHint")));
  if (ready) {
    c.out(st.green(t.t("doctor.ready", { name: ready })));
    return 0;
  }
  c.out(st.red(t.t("doctor.notReady")));
  return 1;
}
