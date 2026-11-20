# Crewreview desktop app

A window and a menu bar (macOS) or tray (Windows, Linux) icon around the crew:

- the dashboard in its own window; closing it keeps the crew working;
- the inbox count next to the icon, and a notification when a review or an answer waits for your approval;
- check pull requests now, open at login, check for updates, quit;
- signed updates of the whole app, the crew included.

It is built with [Tauri 2](https://tauri.app). The crew itself is the `crewreview` CLI, bundled inside the app as a
sidecar, so the app and the CLI never disagree about how reviews work.

## How the app and the crew talk

The app runs `crewreview run --desktop` and reads one JSON object per line from its stdout:

| Message | When | The app |
|---|---|---|
| `{"strings": {...}, "locale": "pt-BR", "updateCheck": true}` | first, always | takes its texts (the `desktop.*` keys of `@crewreview/i18n`) and the `updates.check` setting |
| `{"ready": {"url", "port", "token", "pid", "version"}}` | the crew started and its dashboard is up | opens the dashboard; this crew stops when the app quits |
| `{"attach": {...same fields}}` | a crew already runs (the background service, or a terminal) | shows that crew instead of starting another; the process exits |
| `{"error": "…"}` | the crew can't start | shows the message and tries again later |
| `{"autostart": true}` | the dashboard turned open at login on (or `false`: off) | turns it on or off, then tells the crew |

The app writes JSON lines to the crew's stdin too: `{"desktop": {"autostart": true}}` right after it starts the crew,
and again whenever open at login changes (from the menu or the dashboard), so the dashboard's settings show it.

The crew stops when its stdin closes: when the app quits, and also when it crashes. The app restarts a crew that
stops on its own, sooner if it ran for a while, less and less often if it keeps failing. In desktop mode the CLI never
updates itself; the app's updater replaces both.

The app reads the crew's state from the local API (`/api/state`, `/api/inbox`, `POST /api/cycle`) with the token from
`ready` or `attach`. The dashboard gets the token in the URL fragment, like in a browser. Links to anything other than
the dashboard open in your browser.

The app passes the system language to the crew (`CREWREVIEW_LANG`), since apps opened from the Finder or the Start
menu get no `LANG`. The crew's stderr goes to `crew.log` in the app's log folder.

## Develop

You need Bun and the Rust toolchain (`rustup`).

```bash
bun run sidecar        # compile the CLI from source into src-tauri/binaries (again after you change the CLI)
bun run dev            # run the app
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
```

Set `CREWREVIEW_HOME` to a temporary folder to keep the app's crew away from your real config and repositories.

On Linux, Tauri needs WebKitGTK and an app indicator library: see the "Linux libraries" step in
`.github/workflows/release.yml`.

## Release

The release workflow builds the app on each system around the CLI binaries of the same release: a notarized `.dmg`
for Apple silicon and Intel, an NSIS installer for Windows, and `.AppImage`, `.deb` and `.rpm` for Linux on x64 and
arm64. The `.dmg` is notarized too, not only the app inside it.

The `.dmg` comes from `scripts/make-dmg.sh`, not from Tauri: Tauri skips the window layout of its disk image on CI,
because it drives Finder to do it. The script uses [dmgbuild](https://github.com/dmgbuild/dmgbuild), pinned by hash in
`packaging/macos/dmg/requirements.txt`, which writes the layout into the image itself: a background that says what to
do (`bun scripts/dmg-background.ts` draws it), the app and Applications in place, hidden files out of view.

The app icon comes from `bun scripts/app-icon.ts --install`: a macOS version on Apple's grid (with margins and a
shadow) for the `.icns`, and one with transparent corners for Windows and Linux.

The Linux packages carry the CLI in `usr/libexec/crewreview/` rather than next to the app (`scripts/linux-config.ts`):
linuxdeploy rewrites every binary under `usr/bin` and `usr/lib` of an AppImage, and a Bun-compiled binary crashes after
that. `scripts/check-linux.sh` starts the CLI from each package, in CI and in the release.

The update packages (`.app.tar.gz`, `-setup.exe`, `.AppImage`) are signed with the release key, and their
signatures go into `latest.json`. Each signature names its version (`version:` in the trusted comment), and the app
refuses an update whose signature names another one.

`scripts/tray-icon.ts` draws the macOS menu bar icon; run it only when the shape changes.
