#!/bin/sh
# Install Crewreview on macOS or Linux:
#   curl -fsSL https://crewreview.web.app/install.sh | sh
# Options (environment): CREWREVIEW_VERSION=0.2.0 (default: latest), CREWREVIEW_BIN_DIR=/usr/local/bin (default: ~/.local/bin)
set -eu

REPO="Quost/crewreview"
PUBKEY="RWTk8l0TkAFZQOxVkYWEHrU6Nj+j1UTCGOMps627c4qsvaX3fvRFzhpx"
VERSION="${CREWREVIEW_VERSION:-latest}"
BIN_DIR="${CREWREVIEW_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'crewreview install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
asset="crewreview-$os-$arch"
if [ -n "${CREWREVIEW_BASE_URL:-}" ]; then
  base="$CREWREVIEW_BASE_URL" # mirrors and tests
elif [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v${VERSION#v}"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $asset ($VERSION)…"
curl -fsSL -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: SHA256SUMS"
curl -fsSL -o "$tmp/SHA256SUMS.minisig" "$base/SHA256SUMS.minisig" || die "download failed: SHA256SUMS.minisig"

if command -v minisign >/dev/null 2>&1; then
  minisign -Vqm "$tmp/SHA256SUMS" -P "$PUBKEY" || die "the SHA256SUMS signature doesn't match the release key"
  say "Signature checked with the release key."
else
  say "minisign not found: checking the checksum only (install minisign to check the signature too)."
fi

expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset"

mkdir -p "$BIN_DIR"
mv "$tmp/$asset" "$BIN_DIR/crewreview"
chmod 755 "$BIN_DIR/crewreview"
say "Installed $("$BIN_DIR/crewreview" --version) to $BIN_DIR/crewreview"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add it to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say "Next: crewreview doctor"
