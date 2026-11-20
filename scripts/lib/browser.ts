// A headless Chrome, Edge or Chromium driven over the DevTools protocol, for the scripts that render pictures
// (screenshots.ts, dmg-background.ts). CHROME=/path/to/browser picks one.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function browserPath(): string {
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

export class Page {
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

/** Start the browser with a throwaway profile and open one page. `close` stops it and removes the profile. */
export async function openBrowser(): Promise<{ page: Page; profile: string; close(): Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), "crewreview-browser-"));
  const browser = Bun.spawn(
    [browserPath(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"],
    { stdout: "ignore", stderr: "pipe" },
  );
  const close = async () => {
    browser.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const reader = browser.stderr.getReader();
    let text = "";
    while (!/DevTools listening on (ws:\S+)/.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the browser stopped before it was ready:\n${text}`);
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const devtools = /DevTools listening on (ws:\S+)/.exec(text)![1]!;
    const http = devtools.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
    const target = (await (await fetch(`${http}/json/new?about:blank`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    return { page, profile, close };
  } catch (e) {
    await close();
    throw e;
  }
}
