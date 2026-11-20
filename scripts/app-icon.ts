#!/usr/bin/env bun
// The app icon, drawn once and rendered on a transparent background:
// - packaging/icon/app-icon-macos.png: Apple's grid (an 824 rounded square in 1024, with a soft shadow), for .icns;
// - packaging/icon/app-icon.png: nearly edge to edge with transparent corners, for Windows and Linux.
//   bun scripts/app-icon.ts            render both
//   bun scripts/app-icon.ts --install  and regenerate apps/desktop/src-tauri/icons with `tauri icon`
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser } from "./lib/browser.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "packaging", "icon");

/** The mark: a violet rounded square with a white check. `inset` is the margin, `shadow` Apple's drop shadow. */
function svg(inset: number, shadow: boolean): string {
  const size = 1024 - inset * 2;
  const r = Math.round(size * 0.225);
  const s = size / 824; // the check is drawn for an 824 square
  const x = (n: number) => Math.round(inset + n * s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="fill" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5145e5"/><stop offset="1" stop-color="#7c3aed"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${Math.round(10 * s)}" stdDeviation="${Math.round(12 * s)}" flood-color="#1b1045" flood-opacity="0.32"/>
    </filter>
  </defs>
  <rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${r}" fill="url(#fill)" ${shadow ? 'filter="url(#drop)"' : ""}/>
  <rect x="${inset}" y="${inset}" width="${size}" height="${size}" rx="${r}" fill="url(#shine)"/>
  <path d="M ${x(232)} ${x(430)} L ${x(352)} ${x(550)} L ${x(600)} ${x(290)}" fill="none" stroke="#ffffff" stroke-width="${Math.round(84 * s)}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

const b = await openBrowser();
try {
  await mkdir(OUT, { recursive: true });
  await b.page.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false });
  await b.page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const [name, inset, shadow] of [["app-icon-macos.png", 100, true], ["app-icon.png", 24, false]] as const) {
    const file = join(b.profile, `${name}.html`);
    await writeFile(file, `<!doctype html><html><body style="margin:0;background:transparent">${svg(inset, shadow)}</body></html>`);
    await b.page.send("Page.navigate", { url: `file://${file}` });
    await b.page.waitFor("document.readyState === 'complete'");
    await Bun.sleep(200);
    const shot = await b.page.send("Page.captureScreenshot", { format: "png", omitBackground: true });
    await writeFile(join(OUT, name), Buffer.from(shot.data, "base64"));
  }
  b.page.close();
  console.log("wrote packaging/icon/app-icon-macos.png and app-icon.png");
} finally {
  await b.close();
}

if (process.argv.includes("--install")) {
  // tauri icon writes every size from one source: the macOS file for .icns, the other for everything else.
  const icons = join(ROOT, "apps", "desktop", "src-tauri", "icons");
  const tmp = await mkdtemp(join(tmpdir(), "crewreview-icons-"));
  try {
    for (const [src, dir] of [["app-icon.png", "all"], ["app-icon-macos.png", "mac"]] as const) {
      const p = Bun.spawn(["bunx", "tauri", "icon", join(OUT, src), "-o", join(tmp, dir)], { cwd: join(ROOT, "apps", "desktop"), stdout: "ignore", stderr: "inherit" });
      if ((await p.exited) !== 0) throw new Error(`tauri icon failed for ${src}`);
    }
    for (const f of ["32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico"]) await cp(join(tmp, "all", f), join(icons, f));
    await cp(join(tmp, "mac", "icon.icns"), join(icons, "icon.icns"));
    console.log("updated apps/desktop/src-tauri/icons (tray.png unchanged)");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
