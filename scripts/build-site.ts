#!/usr/bin/env bun
// Build the website into site/public from site/template.html and site/i18n/*.json: English at /, the others at
// /pt/, /es/, /de/, /zh/, with hreflang links, a sitemap, robots.txt and llms.txt. Edit the template and the texts,
// never the generated pages.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json";

const ROOT = join(import.meta.dir, "..");
const SITE = "https://crewreview.web.app";
const LOCALES: Record<string, { path: string; lang: string; name: string }> = {
  en: { path: "/", lang: "en", name: "English" },
  "pt-BR": { path: "/pt/", lang: "pt-BR", name: "Português" },
  es: { path: "/es/", lang: "es", name: "Español" },
  de: { path: "/de/", lang: "de", name: "Deutsch" },
  "zh-CN": { path: "/zh/", lang: "zh-Hans", name: "中文" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const template = await readFile(join(ROOT, "site", "template.html"), "utf8");
const texts: Record<string, Record<string, string>> = {};
for (const f of await readdir(join(ROOT, "site", "i18n"))) texts[f.replace(/\.json$/, "")] = JSON.parse(await readFile(join(ROOT, "site", "i18n", f), "utf8"));

// Every language has exactly the English keys.
const enKeys = Object.keys(texts.en!).sort().join("\n");
for (const [loc, t] of Object.entries(texts)) {
  if (!(loc in LOCALES)) throw new Error(`site/i18n/${loc}.json: no page for this language`);
  if (Object.keys(t).sort().join("\n") !== enKeys) throw new Error(`site/i18n/${loc}.json: keys differ from en.json`);
}

const out = join(ROOT, "site", "public");
await rm(out, { recursive: true, force: true });
const alternates = [
  ...Object.values(LOCALES).map((l) => `<link rel="alternate" hreflang="${l.lang}" href="${SITE}${l.path}">`),
  `<link rel="alternate" hreflang="x-default" href="${SITE}/">`,
].join("\n");
const paths = Object.fromEntries(Object.entries(LOCALES).map(([k, l]) => [k, l.path]));

for (const [loc, info] of Object.entries(LOCALES)) {
  const t = texts[loc]!;
  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Crewreview",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    softwareVersion: pkg.version,
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    description: t["meta.description"],
    url: `${SITE}${info.path}`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    codeRepository: "https://github.com/Quost/crewreview",
  });
  // The questions on the page, as FAQ structured data: what search engines and AI assistants quote.
  const faq = Object.keys(t)
    .filter((k) => /^faq\.q\d+$/.test(k))
    .map((k) => ({ "@type": "Question", name: t[k], acceptedAnswer: { "@type": "Answer", text: t[k.replace(".q", ".a")] } }));
  const graph = JSON.stringify([JSON.parse(jsonld), { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq }]).replace(/</g, "\\u003c");
  const vars: Record<string, string> = {
    lang: info.lang,
    url: `${SITE}${info.path}`,
    home: info.path,
    alternates,
    version: esc(pkg.version),
    jsonld: graph,
    shots: `/shots/${loc}`,
    pathsJson: JSON.stringify(paths),
    langOptions: Object.entries(LOCALES)
      .map(([k, l]) => `<option value="${k}"${k === loc ? " selected" : ""}>${l.name}</option>`)
      .join(""),
  };
  const html = template.replace(/\{\{([\w.]+)\}\}/g, (m, key: string) => {
    if (key in vars) return vars[key]!;
    if (key in t) return key.endsWith("_html") ? t[key]! : esc(t[key]!);
    throw new Error(`template: unknown placeholder ${m}`);
  });
  const dir = join(out, info.path);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), html);
}

// install.sh, install.ps1 and the icon are served as they are.
await cp(join(ROOT, "site", "static"), out, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
await writeFile(
  join(out, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${Object.values(LOCALES)
    .map((l) => `  <url><loc>${SITE}${l.path}</loc><lastmod>${today}</lastmod>${Object.values(LOCALES).map((a) => `<xhtml:link rel="alternate" hreflang="${a.lang}" href="${SITE}${a.path}"/>`).join("")}</url>`)
    .join("\n")}\n</urlset>\n`,
);
await writeFile(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
const en = texts.en!;
await writeFile(
  join(out, "llms.txt"),
  `# Crewreview

> ${en["meta.description"]}

Version ${pkg.version}. Free software (AGPL-3.0). Source: https://github.com/Quost/crewreview

## What it does
- Reviewer: ${en["jobs.reviewerLead"]} ${en["jobs.r1"]} ${en["jobs.r2"]} ${en["jobs.r3"]} ${en["jobs.r4"]}
- Attendant: ${en["jobs.attendantLead"]} ${en["jobs.a1"]} ${en["jobs.a2"]} ${en["jobs.a3"]} ${en["jobs.a4"]}
- Dashboard: ${en["crew.nowd"]} ${en["crew.inboxd"]} ${en["crew.reposd"]}
- Hosts: GitHub and GitLab (cloud and self-managed).
- Harnesses: Claude Code and Codex CLI (review and attend), Kiro CLI (review), any Agent Client Protocol agent or custom CLI after a conformance test.
- Runs on macOS, Linux and Windows as a CLI, a background service and a local dashboard. Interface in English, Brazilian Portuguese, Spanish, German and Simplified Chinese.

## Safety
${[1, 2, 3, 4, 5, 6].map((i) => `- ${en[`safety.f${i}`]}: ${en[`safety.f${i}d`]}`).join("\n")}

## Install
- Desktop app (macOS, Windows, Linux): ${SITE}/#start, or the latest release: https://github.com/Quost/crewreview/releases/latest (Crewreview-macos-arm64.dmg, Crewreview-macos-x64.dmg, Crewreview-windows-x64-setup.exe, Crewreview-linux-x64.AppImage and .deb/.rpm, the same for linux-arm64). It bundles the crew and keeps it running from the menu bar or tray.
- Command line, macOS or Linux: curl -fsSL ${SITE}/install.sh | sh (Homebrew: brew tap Quost/crewreview https://github.com/Quost/crewreview && brew trust quost/crewreview && brew install Quost/crewreview/crewreview)
- Command line, Windows (PowerShell): irm ${SITE}/install.ps1 | iex (Scoop: scoop bucket add crewreview https://github.com/Quost/crewreview; scoop install crewreview/crewreview)

## Using it with a team
- Each developer installs it and links the team's repositories, or a whole GitHub organization or GitLab group (crewreview repo add https://github.com/acme, with --include/--exclude name filters); reviews post from their own account, with the coding agent plan they already have. No server, no seats, no shared API key.
- A commit that already has a Crewreview review on the host is skipped, whoever's crew wrote it, so several people can run it on the same repository.
- Shared rules live in the repository: .crewreview/lenses/<lens>.md replaces or adds a lens, and the crew follows AGENTS.md, CLAUDE.md and CONTRIBUTING.md, all read from the base branch.
- The language of review comments is set per repository (commentLanguage).
- Working alone: GitHub doesn't let you approve your own pull requests, so a repository can post its reviews as a second account (crewreview repo set <id> --account my-bot, signed in to gh; or env:VARIABLE with its token). Approvals from that account count; everything else runs as you.
- Or one bot account reviews for the whole team from a shared machine: a Docker image built from the signed release binary, with the dashboard reached over SSH. Guide: https://github.com/Quost/crewreview/blob/main/docs/team-machine.md

## Setting it up for someone (for AI agents)
1. Install the command line tool (above). Explain each command before running it.
2. Run crewreview doctor. It needs git, at least one coding agent signed in (Claude Code, Codex or Kiro) and gh (GitHub) or glab (GitLab) signed in. If something is missing, tell the user how to fix it and wait.
3. Ask which repositories to watch, or whether to link a whole organization or group (every repository in it, new ones too). Link each in inbox mode, so nothing is posted without approval: crewreview repo add <repository or organization url> --attend inbox. Never switch a repository to auto unless the user asks.
4. Keep it running and open the dashboard: crewreview service install, then crewreview ui.
5. Connect it to the user's coding agents: crewreview mcp setup prints the steps for each. Claude Code: /plugin marketplace add Quost/crewreview, then /plugin install crewreview@crewreview.

## Commands
- crewreview doctor --conformance: prove each harness's read-only and write-scope locks on this machine.
- crewreview local: review the current branch; nothing is posted.
- crewreview repo add <url> [--mode inbox|auto] [--attend off|inbox|auto] [--polish on]: link a repository.
- crewreview review <repo> <number> / crewreview attend <repo> <number>: run one now.
- crewreview inbox [show|approve|discard] <id>: what waits for approval.
- crewreview run / ui / service install / update: the daemon, its dashboard, start with login, signed updates.

## Not included
No hosted service, no account, no telemetry. It doesn't merge pull requests and never force-pushes.
`,
);
console.log(`site built in site/public (${Object.keys(LOCALES).length} languages, v${pkg.version})`);
