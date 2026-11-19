#!/usr/bin/env bash
# The CLI inside each Linux package is executable and starts: bash scripts/check-linux.sh <bundle-dir>
# Needs dpkg-deb and rpm2cpio + cpio (Ubuntu: apt-get install rpm2cpio cpio).
set -euo pipefail
b="$(cd "$1" && pwd)"
cli=usr/libexec/crewreview/crewreview
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

appimage="$(ls "$b"/appimage/*.AppImage)"
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
echo "AppImage: $("$work/squashfs-root/$cli" --version)"
[ ! -e "$work/squashfs-root/usr/bin/crewreview" ] || { echo "the AppImage still has usr/bin/crewreview"; exit 1; }

dpkg-deb -x "$(ls "$b"/deb/*.deb)" "$work/deb"
echo "deb: $("$work/deb/$cli" --version)"

mkdir "$work/rpm"
(cd "$work/rpm" && rpm2cpio "$(ls "$b"/rpm/*.rpm)" | cpio -idm --quiet)
echo "rpm: $("$work/rpm/$cli" --version)"
