#!/usr/bin/env bash
# The macOS disk image around the app Tauri built: a window that says what to do (drag the app into
# Applications), with a background, an arrow and its icons in place, hidden files out of view.
#   bash apps/desktop/scripts/make-dmg.sh <rust target> [out.dmg]
# Tauri's own image skips that layout on CI (it needs Finder there), so the release builds this one with dmgbuild,
# which writes the layout straight into the image. With APPLE_SIGNING_IDENTITY set, the image is signed too;
# the release notarizes and staples it afterwards.
set -Eeuo pipefail
trap 'echo "make-dmg: failed at line $LINENO" >&2' ERR

target="${1:?usage: make-dmg.sh <rust target> [out.dmg]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
here="$root/packaging/macos/dmg"
bundle="$root/apps/desktop/src-tauri/target/$target/release/bundle"
app="$bundle/macos/Crewreview.app"
[ -d "$app" ] || { echo "make-dmg: no app at $app (build it first with --bundles app)" >&2; exit 1; }

version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$root/apps/desktop/package.json" | head -1)"
case "$target" in aarch64-*) arch=aarch64 ;; x86_64-*) arch=x64 ;; *) arch="${target%%-*}" ;; esac
out="${2:-$bundle/dmg/Crewreview_${version}_${arch}.dmg}"
mkdir -p "$(dirname "$out")"
rm -f "$out"

# dmgbuild in its own environment, exactly the pinned files.
venv="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/crewreview-dmgbuild"
if [ ! -x "$venv/bin/dmgbuild" ]; then
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet --disable-pip-version-check --require-hashes --only-binary :all: -r "$here/requirements.txt"
fi

"$venv/bin/dmgbuild" -s "$here/settings.py" \
  -D app="$app" -D background="$here/background.png" -D icon="$app/Contents/Resources/icon.icns" \
  "Crewreview" "$out"

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$out"
  codesign --verify --verbose=1 "$out"
fi

# What's inside, as a check: the app, the Applications link, and the layout file.
mnt="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mnt" "$out"
ok=1
[ -d "$mnt/Crewreview.app" ] || { echo "make-dmg: the app is missing from the image" >&2; ok=0; }
[ "$(readlink "$mnt/Applications")" = /Applications ] || { echo "make-dmg: the Applications link is missing" >&2; ok=0; }
[ -f "$mnt/.DS_Store" ] && [ -f "$mnt/.background.tiff" ] || { echo "make-dmg: the window layout is missing" >&2; ok=0; }
hdiutil detach -quiet "$mnt"
rmdir "$mnt" 2>/dev/null || true
[ "$ok" = 1 ]
echo "$out"
