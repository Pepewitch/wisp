#!/usr/bin/env bash
# Give an installed `wisp` binary a Finder icon, so macOS can tell one copy
# from another in Privacy & Security ▸ App Management.
#
#   bash scripts/macos/stamp-icon.sh                    # stamp `which wisp`
#   bash scripts/macos/stamp-icon.sh --dev dist/wisp    # stamp a local build
#   bash scripts/macos/stamp-icon.sh --clear dist/wisp  # take the icon back off
#
# macOS lists an unbundled executable in App Management under its file name
# with its file icon. Every Wisp release and every `bun run build` produces a
# Mach-O called `wisp` with no icon, so the list fills with identical rows.
# Stamping one binary is what makes its row legible; docs/MACOS-APP-MANAGEMENT.md
# explains why the rows accumulate in the first place.
#
# A custom file icon lives in the file's resource fork, outside the Mach-O, so
# this does not touch the code directory: the cdhash, the ad-hoc signature, the
# binary's TCC identity, and any permission already granted to it all survive.
# `codesign --verify` still passes. `codesign --verify --strict` does not — it
# rejects a resource fork as "detritus" — which is why this refuses to stamp a
# release artifact, whose whole point is to pass the strict check.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
variant=""
clear_icon=false
target=""

usage() {
  cat <<'EOF'
usage: stamp-icon.sh [--prod|--dev] [--clear] [binary]

  binary    path to a wisp Mach-O; defaults to the `wisp` on PATH
  --prod    stamp the production icon (brand/cli-icon.png)
  --dev     stamp the development icon (brand/cli-icon-dev.png)
  --clear   remove any custom icon instead of stamping one

Without --prod or --dev the variant is inferred: a binary under a source
checkout is development, anything else is production.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prod) variant="prod" ;;
    --dev) variant="dev" ;;
    --clear) clear_icon=true ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "stamp-icon: unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)
      [ -z "$target" ] || { echo "stamp-icon: one binary at a time, got $target and $1" >&2; exit 1; }
      target="$1"
      ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || { echo "stamp-icon: macOS only" >&2; exit 1; }

if [ -z "$target" ]; then
  target="$(command -v wisp || true)"
  [ -n "$target" ] || { echo "stamp-icon: no wisp on PATH; pass a binary path" >&2; exit 1; }
fi
[ -f "$target" ] || { echo "stamp-icon: not a file: $target" >&2; exit 1; }
target="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
# Resolve the Homebrew symlink: the icon belongs on the Cellar file, which is
# the path macOS records, not on the /opt/homebrew/bin shim.
while [ -L "$target" ]; do
  link="$(readlink "$target")"
  case "$link" in
    /*) target="$link" ;;
    *) target="$(cd "$(dirname "$target")" && cd "$(dirname "$link")" && pwd -P)/$(basename "$link")" ;;
  esac
done

/usr/bin/file -b "$target" | grep -q 'Mach-O' ||
  { echo "stamp-icon: not a Mach-O executable: $target" >&2; exit 1; }
case "$target" in
  */dist/release/*)
    echo "stamp-icon: refusing to stamp a release artifact: $target" >&2
    echo "  release binaries must keep passing 'codesign --verify --strict'" >&2
    exit 1
    ;;
esac

if [ -z "$variant" ]; then
  if [ -f "$(dirname "$target")/../package.json" ] || [ -d "$(dirname "$target")/../.git" ]; then
    variant="dev"
  else
    variant="prod"
  fi
fi

# The icon has to be written through the file, so a read-only Homebrew binary
# (mode 555) needs its owner write bit back afterwards.
mode="$(/usr/bin/stat -f '%Lp' "$target")"
restore_mode() { chmod "$mode" "$target" 2>/dev/null || true; }
trap restore_mode EXIT
chmod u+w "$target"

if [ "$clear_icon" = true ]; then
  xattr -d com.apple.ResourceFork "$target" 2>/dev/null || true
  xattr -d com.apple.FinderInfo "$target" 2>/dev/null || true
  echo "cleared the custom icon on $target"
  exit 0
fi

case "$variant" in
  dev) source_pdf="$root/brand/cli-icon-dev.pdf" ;;
  *) source_pdf="$root/brand/cli-icon.pdf" ;;
esac
[ -f "$source_pdf" ] || { echo "stamp-icon: missing $source_pdf — run: bun run brand" >&2; exit 1; }
for tool in sips iconutil osascript; do
  command -v "$tool" >/dev/null 2>&1 || { echo "stamp-icon: $tool is required" >&2; exit 1; }
done

# Rasterise the vector master once per slot rather than downscaling one large
# PNG: the slot that decides whether this worked is a Settings row, and a
# resampled 512px master is mush there. Same .icns derivation as
# scripts/desktop/icons.sh, one size pyramid wider at the small end.
work="$(mktemp -d)"
cleanup() { rm -rf "$work"; restore_mode; }
trap cleanup EXIT
set="$work/icon.iconset"
mkdir -p "$set"
for size in 16 32 128 256 512; do
  sips -s format png -Z "$size" "$source_pdf" --out "$set/icon_${size}x${size}.png" >/dev/null
  sips -s format png -Z "$((size * 2))" "$source_pdf" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o "$work/icon.icns"

cat >"$work/set-icon.js" <<'JS'
ObjC.import('Cocoa')
const argv = $.NSProcessInfo.processInfo.arguments
const icon = ObjC.unwrap(argv.objectAtIndex(4))
const file = ObjC.unwrap(argv.objectAtIndex(5))
const image = $.NSImage.alloc.initWithContentsOfFile(icon)
if (!image.js) throw new Error('could not read ' + icon)
if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, file, 0)) {
  throw new Error('NSWorkspace refused to set the icon on ' + file)
}
JS
osascript -l JavaScript "$work/set-icon.js" "$work/icon.icns" "$target"

echo "stamped the $variant icon on $target"
/usr/bin/codesign --verify "$target" >/dev/null 2>&1 &&
  echo "  code signature still valid (strict verification now reports a resource fork, as expected)"
echo "  Finder shows it immediately; App Management redraws the row when System Settings next opens."
