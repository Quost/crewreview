#!/usr/bin/env bun
// The picture behind the macOS disk image window: what to do (drag the app into Applications), on a tray whose
// colour keeps Finder's icon labels readable in light mode (black text) and dark mode (white text).
//   bun scripts/dmg-background.ts
// Writes packaging/macos/dmg/background.png (660×420) and background@2x.png; dmgbuild joins them into one HiDPI
// image. The icon positions in packaging/macos/dmg/settings.py must match APP and APPS below.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openBrowser } from "./lib/browser.ts";

const OUT = join(import.meta.dir, "..", "packaging", "macos", "dmg");
export const WIDTH = 660;
export const HEIGHT = 420;
/** Icon centres, in points: keep in step with settings.py. */
const APP = { x: 165, y: 200 };
const APPS = { x: 495, y: 200 };

// A curve from the app to Applications; the head follows the curve's direction where it ends.
const FROM = { x: APP.x + 82, y: APP.y - 6 };
const C1 = { x: APP.x + 130, y: APP.y - 40 };
const C2 = { x: APPS.x - 140, y: APPS.y - 8 };
const TIP = { x: APPS.x - 86, y: APPS.y - 8 };
const HEAD = (() => {
  const [dx, dy] = [TIP.x - C2.x, TIP.y - C2.y];
  const len = Math.hypot(dx, dy);
  const [ux, uy] = [dx / len, dy / len];
  const r = (n: number) => Math.round(n * 10) / 10;
  return [1, -1].map((side) => ({ x: r(TIP.x - 17 * ux + side * 11 * -uy), y: r(TIP.y - 17 * uy + side * 11 * ux) }));
})();

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
    color: #1b1d2a;
    background:
      radial-gradient(520px 260px at 50% -40px, rgba(124, 108, 255, 0.22), transparent 70%),
      radial-gradient(300px 200px at 92% 110%, rgba(124, 108, 255, 0.12), transparent 70%),
      linear-gradient(180deg, #f8f8fd 0%, #f1f1f8 100%);
    position: relative;
  }
  h1 { position: absolute; top: 28px; left: 0; right: 0; margin: 0; text-align: center; font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  p.sub { position: absolute; top: 62px; left: 0; right: 0; margin: 0; text-align: center; font-size: 13px; color: #5d6479; }
  .tray {
    position: absolute; left: 40px; top: 104px; width: 580px; height: 214px; border-radius: 28px;
    background: linear-gradient(180deg, #7b77cd 0%, #6d68c2 100%);
    box-shadow: 0 18px 40px rgba(80, 70, 180, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.35), inset 0 -1px 0 rgba(0, 0, 0, 0.08);
  }
  .tray::before { /* a soft light where the app sits */
    content: ""; position: absolute; left: ${APP.x - 40 - 90}px; top: ${APP.y - 104 - 90}px; width: 180px; height: 180px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.22), transparent 70%);
  }
  svg.arrow { position: absolute; left: 0; top: 0; }
  p.foot { position: absolute; bottom: 30px; left: 0; right: 0; margin: 0; text-align: center; font-size: 11.5px; color: #8a90a3; letter-spacing: 0.01em; }
  p.foot b { color: #6a6fb8; font-weight: 600; }
</style></head><body>
  <h1>Drag Crewreview into Applications</h1>
  <p class="sub">Then open it from Applications. A short setup does the rest.</p>
  <div class="tray"></div>
  <svg class="arrow" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <defs>
      <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <g filter="url(#glow)" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M ${FROM.x} ${FROM.y} C ${C1.x} ${C1.y}, ${C2.x} ${C2.y}, ${TIP.x} ${TIP.y}" stroke-dasharray="1 13"/>
      <path d="M ${HEAD[0]!.x} ${HEAD[0]!.y} L ${TIP.x} ${TIP.y} L ${HEAD[1]!.x} ${HEAD[1]!.y}"/>
    </g>
  </svg>
  <p class="foot"><b>Free and open source</b> · crewreview.pururucos.com.br</p>
</body></html>`;

const b = await openBrowser();
try {
  await mkdir(OUT, { recursive: true });
  const file = join(b.profile, "dmg.html");
  await writeFile(file, html);
  for (const scale of [1, 2]) {
    await b.page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: scale, mobile: false });
    await b.page.send("Page.navigate", { url: `file://${file}` });
    await b.page.waitFor("document.readyState === 'complete'");
    await Bun.sleep(300);
    const shot = await b.page.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(OUT, scale === 1 ? "background.png" : "background@2x.png"), Buffer.from(shot.data, "base64"));
  }
  b.page.close();
  console.log(`wrote ${join("packaging", "macos", "dmg")}/background.png and background@2x.png`);
} finally {
  await b.close();
}
