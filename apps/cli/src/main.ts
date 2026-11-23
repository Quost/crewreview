#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { behindService } from "@crewreview/core";
import { ConfigError, configFile, loadConfig, readApiInfo } from "@crewreview/engine";
import { createTranslator, detectLocale, type Translator } from "@crewreview/i18n";
import pkg from "../../../package.json";
import { attendOne } from "./commands/attend.ts";
import { doctor } from "./commands/doctor.ts";
import { mcp, mcpSetup } from "./commands/mcp.ts";
import { inbox } from "./commands/inbox.ts";
import { local } from "./commands/local.ts";
import { repo } from "./commands/repo.ts";
import { task } from "./commands/task.ts";
import { daemon, status, ui } from "./commands/daemon.ts";
import { service, update } from "./commands/system.ts";
import { reviewOne } from "./commands/review.ts";
import { makeCtx } from "./ctx.ts";

const VERSION: string = pkg.version;

// `crewreview doctor | head` closes the pipe early; that's not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

function help(t: Translator): string {
  const row = (name: string, text: string) => `  ${name.padEnd(30)} ${text}`;
  return [
    `crewreview ${VERSION}`,
    "",
    t.t("cli.usage"),
    "",
    `${t.t("cli.commands")}:`,
    row("local", t.t("cli.cmd.local")),
    row("repo [list|add|set|remove]", t.t("cli.cmd.repo")),
    row("review <repo> <number>", t.t("cli.cmd.review")),
    row('task "<what to do>" --repo <id>', t.t("cli.cmd.task")),
    row("attend <repo> <number>", t.t("cli.cmd.attend")),
    row("inbox [show|approve|discard]", t.t("cli.cmd.inbox")),
    row("once", t.t("cli.cmd.once")),
    row("run [--open] [--no-ui]", t.t("cli.cmd.run")),
    row("status", t.t("cli.cmd.status")),
    row("ui", t.t("cli.cmd.ui")),
    row("service [install|uninstall]", t.t("cli.cmd.service")),
    row("update [--check]", t.t("cli.cmd.update")),
    row("mcp [setup]", t.t("cli.cmd.mcp")),
    row("doctor", t.t("cli.cmd.doctor")),
    row("version", t.t("cli.cmd.version")),
    row("help", t.t("cli.cmd.help")),
    "",
    `${t.t("cli.options")} (local):`,
    row("--base <ref>", t.t("cli.opt.base")),
    row("--uncommitted", t.t("cli.opt.uncommitted")),
    row("--harness <id>", t.t("cli.opt.harness")),
    row("--verifier-harness <id>", t.t("cli.opt.verifierHarness")),
    row("--lens <a,b>", t.t("cli.opt.lens")),
    row("--no-verify", t.t("cli.opt.noVerify")),
    row("--lang <code>", t.t("cli.opt.lang")),
    row("--json", t.t("cli.opt.json")),
    "",
    `${t.t("cli.options")} (repo):`,
    row("--mode off|inbox|auto", t.t("cli.opt.mode")),
    row("--authors others|all|mine", t.t("cli.opt.authors")),
    row("--kind github|gitlab", t.t("cli.opt.kind")),
    row("--clone <path>", t.t("cli.opt.clone")),
    row("--id <id>", t.t("cli.opt.id")),
    row("--attend off|inbox|auto", t.t("cli.opt.attend")),
    row("--polish on|off", t.t("cli.opt.polish")),
    row("--conflicts on|off", t.t("cli.opt.conflicts")),
    row("--ci on|off", t.t("cli.opt.ci")),
    row("--protected approve|auto", t.t("cli.opt.protected")),
    row("--account <login>|env:<VAR>|none", t.t("cli.opt.account")),
    row("--paused on|off", t.t("cli.opt.paused")),
    row("--guidelines <a,b>|none", t.t("cli.opt.guidelines")),
    row("--approve on|off|default", t.t("cli.opt.approve")),
    row("--include <a,b>", t.t("cli.opt.include")),
    row("--exclude <a,b>", t.t("cli.opt.exclude")),
    row("--lang <code>", t.t("cli.opt.lang")),
    "",
    `${t.t("cli.options")} (review, attend):`,
    row("--post", t.t("cli.opt.post")),
    row("--dry-run", t.t("cli.opt.dryRun")),
    row("--force", t.t("cli.opt.force")),
    row("--retry", t.t("cli.opt.retry")),
    "",
    `${t.t("cli.options")} (doctor):`,
    row("--conformance", t.t("cli.opt.conformance")),
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      base: { type: "string" },
      uncommitted: { type: "boolean", default: false },
      harness: { type: "string" },
      "verifier-harness": { type: "string" },
      lens: { type: "string" },
      "no-verify": { type: "boolean", default: false },
      lang: { type: "string" },
      json: { type: "boolean", default: false },
      conformance: { type: "boolean", default: false },
      mode: { type: "string" },
      authors: { type: "string" },
      kind: { type: "string" },
      clone: { type: "string" },
      id: { type: "string" },
      attend: { type: "string" },
      polish: { type: "string" },
      include: { type: "string" },
      conflicts: { type: "string" },
      account: { type: "string" },
      paused: { type: "string" },
      guidelines: { type: "string" },
      approve: { type: "string" },
      ci: { type: "string" },
      protected: { type: "string" },
      exclude: { type: "string" },
      post: { type: "boolean", default: false },
      repo: { type: "string" },
      auto: { type: "boolean", default: false },
      as: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "no-ui": { type: "boolean", default: false },
      retry: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      channel: { type: "string" },
      open: { type: "boolean", default: false },
      port: { type: "string" },
      // Used by the desktop app, not listed in help.
      desktop: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const [command = v.version ? "version" : "help", ...rest] = positionals;

  let loaded;
  try {
    loaded = await loadConfig(configFile());
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${createTranslator(detectLocale()).t("error.config", { path: e.path, message: e.message })}\n`);
    return 2;
  }
  const t = createTranslator(detectLocale(loaded.config.language));
  const c = makeCtx(t, loaded.config, loaded.path, loaded.exists, VERSION);
  if (v.help) return (c.out(help(t)), 0);
  // A terminal copy older than the running service answers for a version that no longer runs: say so, once.
  if (!["run", "version", "help", "mcp"].includes(command)) {
    const service = (await readApiInfo(c.dirs.state))?.version;
    if (behindService(VERSION, service)) c.err(c.errStyle.yellow(t.t("cli.behindService", { version: VERSION, service: service! })));
  }

  try {
    switch (command) {
      case "help":
        c.out(help(t));
        return 0;
      case "version":
        c.out(VERSION);
        return 0;
      case "doctor":
        return await doctor(c, v.conformance);
      case "local":
        return await local(c, {
          base: v.base,
          uncommitted: v.uncommitted,
          harness: v.harness,
          verifierHarness: v["verifier-harness"],
          lens: v.lens,
          verify: !v["no-verify"],
          lang: v.lang,
          json: v.json,
        });
      case "repo":
        return await repo(c, rest[0], rest.slice(1), { kind: v.kind, mode: v.mode, authors: v.authors, clone: v.clone, lang: v.lang, id: v.id, attend: v.attend, polish: v.polish, include: v.include, exclude: v.exclude, conflicts: v.conflicts, ci: v.ci, protected: v.protected, account: v.account, paused: v.paused, guidelines: v.guidelines, approve: v.approve });
      case "review":
        return await reviewOne(c, rest[0], rest[1], { post: v.post, dryRun: v["dry-run"], force: v.force });
      case "task":
        return await task(c, rest, { repo: v.repo, base: v.base, auto: v.auto, as: v.as });
      case "attend":
        return await attendOne(c, rest[0], rest[1], { post: v.post, dryRun: v["dry-run"], retry: v.retry });
      case "mcp":
        return rest[0] === "setup" ? mcpSetup(c) : await mcp(c);
      case "service":
        return await service(c, rest[0]);
      case "update":
        return await update(c, v.check, v.channel);
      case "inbox":
        return await inbox(c, rest[0], rest.slice(1));
      case "once":
        return await daemon(c, { loop: false, ui: false, open: false });
      case "run":
        return await daemon(c, { loop: true, ui: !v["no-ui"], open: v.open, port: v.port ? Number(v.port) : undefined, desktop: v.desktop });
      case "status":
        return await status(c);
      case "ui":
        return await ui(c, v.port ? Number(v.port) : undefined);
      default:
        c.err(t.t("cli.unknownCommand", { name: command }));
        c.err();
        c.err(help(t));
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      c.err(t.t("error.config", { path: e.path, message: e.message }));
      return 2;
    }
    throw e;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
