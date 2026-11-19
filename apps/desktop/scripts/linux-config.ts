#!/usr/bin/env bun
// Print the config the Linux packages are built with:
//   bunx tauri build --target <triple> --config "$(bun scripts/linux-config.ts <triple>)"
// linuxdeploy rewrites every binary under usr/bin and usr/lib of an AppImage (rpath, strip), and the Bun-compiled CLI
// crashes after that. So the AppImage, the .deb and the .rpm carry the CLI in usr/libexec/crewreview, where nothing
// touches it, and the app looks there first (sidecar_in in src-tauri/src/crew.rs).
const [triple] = process.argv.slice(2);
if (!triple?.endsWith("-linux-gnu")) {
  console.error("usage: bun scripts/linux-config.ts <x86_64|aarch64>-unknown-linux-gnu");
  process.exit(2);
}
const files = { "/usr/libexec/crewreview/crewreview": `binaries/crewreview-${triple}` };
console.log(JSON.stringify({ bundle: { externalBin: [], linux: { appimage: { files }, deb: { files }, rpm: { files } } } }));
