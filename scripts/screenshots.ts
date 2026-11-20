#!/usr/bin/env bun
// Screenshots of the dashboard with the demo data (scripts/demo-dashboard.ts), in every language and both themes,
// for the website and the README. Needs Google Chrome, Microsoft Edge or Chromium (CHROME=/path/to/browser).
//   bun scripts/screenshots.ts [--lang en] [--page now]
// Writes site/static/shots/<language>/<page>-<light|dark>.webp, and og.png (the link preview, 1200×630) from the
// website's own title. Run it again after a visible dashboard change or a new title.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCALES } from "../packages/i18n/src/index.ts";
import { openBrowser } from "./lib/browser.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "site", "static", "shots");
const WIDTH = 1280;
const HEIGHT = 800;
const THEMES = ["light", "dark"] as const;
/** Each page, and what to do before the picture: the inbox shows a review by default, "fix" opens the attendant's answer. */
const PAGES: Record<string, { hash: string; click?: string }> = {
  now: { hash: "now" },
  inbox: { hash: "inbox" },
  fix: { hash: "inbox", click: "button.item:not(.on)" },
  history: { hash: "history" },
  repos: { hash: "repos" },
  limits: { hash: "limits" },
};

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const langs = arg("lang") ? [arg("lang")!] : [...LOCALES];
const only = arg("page");
const pages = only ? (only === "og" ? [] : [only]) : Object.keys(PAGES);

// ---- the demo dashboard ----
const demo = Bun.spawn(["bun", join(ROOT, "scripts", "demo-dashboard.ts")], { stdout: "pipe", stderr: "inherit" });

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!.trim();
}

const b = await openBrowser();
const profile = b.profile;

try {
  const base = (await firstLine(demo.stdout)).replace(/#.*$/, "");
  const page = b.page;
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });

  let count = 0;
  for (const lang of langs) {
    await mkdir(join(OUT, lang), { recursive: true });
    for (const theme of THEMES) {
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
      // Language and token first, then a fresh load so the dashboard starts in that language.
      await page.send("Page.navigate", { url: `${base}#token=demo` });
      await page.waitFor("document.querySelector('.shell')");
      await page.eval(`localStorage.setItem("crewreview.lang", ${JSON.stringify(lang)}); location.reload()`);
      await Bun.sleep(300);
      await page.waitFor(`document.documentElement.lang === ${JSON.stringify(lang)} && document.querySelector('.shell')`);
      for (const name of pages) {
        const p = PAGES[name]!;
        // The way a click in the sidebar changes pages: the token stays in this tab's session.
        await page.eval(`location.hash = "#/${p.hash}"`);
        await page.waitFor(`document.querySelector('.side nav a.active')?.getAttribute('href') === "#/${p.hash}"`);
        await Bun.sleep(700);
        if (p.click) {
          await page.eval(`document.querySelector(${JSON.stringify(p.click)}).click()`);
          await Bun.sleep(600);
        }
        const shot = await page.send("Page.captureScreenshot", { format: "webp", quality: 86 });
        const file = join(OUT, lang, `${name}-${theme}.webp`);
        await writeFile(file, Buffer.from(shot.data, "base64"));
        count++;
      }
    }
    console.log(`${lang}: ${pages.length * THEMES.length} screenshots`);
  }
  // The link preview: the website's title next to the dashboard, in each language.
  if (!only || only === "og") {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
    for (const lang of langs) {
      const t = JSON.parse(await readFile(join(ROOT, "site", "i18n", `${lang}.json`), "utf8"));
      const card = join(profile, `og-${lang}.html`);
      await writeFile(card, ogCard(t, `file://${join(OUT, lang, "now-dark.webp")}`));
      await page.send("Page.navigate", { url: `file://${card}` });
      await page.waitFor("document.readyState === 'complete' && document.querySelector('img').complete");
      await Bun.sleep(200);
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(OUT, lang, "og.png"), Buffer.from(shot.data, "base64"));
      count++;
    }
  }
  page.close();
  console.log(`${count} images in site/static/shots`);
} finally {
  await b.close();
  demo.kill();
}

function ogCard(t: Record<string, string>, shot: string): string {
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
background:radial-gradient(900px 500px at 85% 20%,#2b2a6b,transparent),linear-gradient(135deg,#0c0e15,#151030);color:#e9ebf4}
.text{position:absolute;left:64px;top:64px;width:560px}
.brand{display:flex;align-items:center;gap:14px;font-size:30px;font-weight:750}
.logo{display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#8b8cf6,#b18cf6);color:#fff;font-size:26px}
h1{font-size:50px;line-height:1.08;letter-spacing:-.02em;margin:44px 0 26px}
h1 em{font-style:normal;background:linear-gradient(90deg,#8b8cf6,#c4a1ff);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin:0;font-size:22px;color:#9aa1b8}
img{position:absolute;left:660px;top:110px;width:820px;border-radius:14px;border:1px solid #272c3f;box-shadow:0 30px 80px rgb(0 0 0/60%)}
</style><div class="text"><div class="brand"><span class="logo">✓</span>Crewreview</div><h1>${t["hero.title_html"]}</h1>
<p>${esc(t["hero.eyebrow"] ?? "")} · macOS · Windows · Linux</p></div><img src="${shot}">`;
}
