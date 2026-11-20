#!/usr/bin/env bun
// Screenshots of the dashboard with the demo data (scripts/demo-dashboard.ts), in every language and both themes,
// for the website and the README. Needs Google Chrome, Microsoft Edge or Chromium (CHROME=/path/to/browser).
//   bun scripts/screenshots.ts [--lang en] [--page now]
// Writes site/static/shots/<language>/<page>-<light|dark>.webp, and og.png (the link preview, 1200×630) from the
// website's own title. Run it again after a visible dashboard change or a new title.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCALES } from "../packages/i18n/src/index.ts";

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

function browserPath(): string {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error("no Chrome, Edge or Chromium found; set CHROME=/path/to/browser");
  return found;
}

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

// ---- a headless browser driven over the DevTools protocol ----
class Page {
  private id = 0;
  private waiting = new Map<number, (v: any) => void>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.waiting.has(m.id)) {
        this.waiting.get(m.id)!(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
        this.waiting.delete(m.id);
      }
    };
  }
  static async open(url: string): Promise<Page> {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.onopen = ok;
      ws.onerror = fail;
    });
    return new Page(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value as T;
  }
  async waitFor(expression: string, timeout = 5000): Promise<void> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }
  close() {
    this.ws.close();
  }
}

const profile = await mkdtemp(join(tmpdir(), "crewreview-shots-"));
const browser = Bun.spawn(
  [browserPath(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"],
  { stdout: "ignore", stderr: "pipe" },
);

try {
  const base = (await firstLine(demo.stdout)).replace(/#.*$/, "");
  let devtools = "";
  {
    const reader = browser.stderr.getReader();
    let text = "";
    while (!/DevTools listening on (ws:\S+)/.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the browser stopped before it was ready:\n${text}`);
      text += new TextDecoder().decode(value);
    }
    devtools = /DevTools listening on (ws:\S+)/.exec(text)![1]!;
    reader.releaseLock();
  }
  const http = devtools.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
  const target = (await (await fetch(`${http}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
  const page = await Page.open(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
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
  browser.kill();
  demo.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
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
