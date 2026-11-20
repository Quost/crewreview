#!/usr/bin/env bash
# The CLI inside each Linux package is executable and starts: bash scripts/check-linux.sh <bundle-dir>
# Needs dpkg-deb and bsdtar (Ubuntu: apt-get install libarchive-tools).
set -Eeuo pipefail
trap 'echo "check-linux.sh failed at line $LINENO: $BASH_COMMAND" >&2' ERR
b="$(cd "$1" && pwd)"
cli=usr/libexec/crewreview/crewreview
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Runs the CLI from one package; fails when it doesn't print a version.
starts() {
  local version
  version="$("$2" --version)"
  [ -n "$version" ]
  echo "$1: $version"
}

appimage="$(ls "$b"/appimage/*.AppImage)"
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
starts AppImage "$work/squashfs-root/$cli"
[ ! -e "$work/squashfs-root/usr/bin/crewreview" ] || { echo "the AppImage still has usr/bin/crewreview"; exit 1; }

dpkg-deb -x "$(ls "$b"/deb/*.deb)" "$work/deb"
starts deb "$work/deb/$cli"

mkdir "$work/rpm"
bsdtar -xf "$(ls "$b"/rpm/*.rpm)" -C "$work/rpm"
starts rpm "$work/rpm/$cli"
