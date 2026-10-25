#!/usr/bin/env bash
# Installs the standalone retire-overrides CLI from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/Sumedhbhat/retire-overrides/main/scripts/install.sh | bash -s -- [stable|nightly|vX.Y.Z]
#
# Installs into $PREFIX (default ~/.local): $PREFIX/lib/retire-overrides/<version> and $PREFIX/bin/retire-overrides.
# Needs bash, curl, tar, sha256sum (or shasum) and Node.js 22.18 or later.
set -euo pipefail

repo=Sumedhbhat/retire-overrides
channel=${1:-stable}
prefix=${PREFIX:-$HOME/.local}
api=https://api.github.com/repos/$repo

case $channel in
  stable) tag=$(curl -fsSL "$api/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) ;;
  nightly) tag=$(curl -fsSL "$api/releases?per_page=30" | sed -n 's/.*"tag_name": *"\(v[^"]*-nightly\.[0-9]*\)".*/\1/p' | head -1) ;;
  v*) tag=$channel ;;
  *) echo "usage: install.sh [stable|nightly|vX.Y.Z]" >&2; exit 2 ;;
esac
[[ -n ${tag:-} ]] || { echo "no $channel release found" >&2; exit 1; }
version=${tag#v}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base=https://github.com/$repo/releases/download/$tag
curl -fsSL -o "$work/retire-overrides-$version.tar.gz" "$base/retire-overrides-$version.tar.gz"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"
if command -v sha256sum >/dev/null; then
  (cd "$work" && sha256sum --check --status SHA256SUMS)
else
  (cd "$work" && shasum -a 256 --check --status SHA256SUMS)
fi

dest=$prefix/lib/retire-overrides/$version
mkdir -p "$dest" "$prefix/bin"
tar -xzf "$work/retire-overrides-$version.tar.gz" -C "$dest" --strip-components=1
ln -sf "$dest/dist/cli.mjs" "$prefix/bin/retire-overrides"
echo "installed retire-overrides $(cat "$dest/VERSION") to $prefix/bin/retire-overrides"
