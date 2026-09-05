#!/usr/bin/env bash
# Build desktop/src-tauri/icons/icon.icns from the committed icon.png.
#
# The PNG is a generated brand asset (scripts/brand/build.ts); the .icns is a
# pure container around it, so it is derived here at build time rather than
# committed. iconutil and sips are macOS-only, which is fine: this is the
# macOS bundle step.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
icons="$root/desktop/src-tauri/icons"
source_png="$icons/icon.png"
out="$icons/icon.icns"

if [ ! -f "$source_png" ]; then
  echo "missing $source_png — run: bun run brand" >&2
  exit 1
fi
for tool in sips iconutil; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required (macOS only)" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
set="$work/icon.iconset"
mkdir -p "$set"

for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$source_png" --out "$set/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$source_png" \
    --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns "$set" -o "$out"
echo "wrote $out"
