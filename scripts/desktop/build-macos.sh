#!/usr/bin/env bash
# Build the Wisp desktop .app for Apple Silicon macOS.
#
#   bash scripts/desktop/build-macos.sh            # .app + .dmg
#   bash scripts/desktop/build-macos.sh --app-only # skip the .dmg
#
# The webview loads the same generated web/ui-dist bundle the daemon serves.
# Ordinary builds refresh it here. The release workflow supplies one verified
# cross-job bundle and sets WISP_PREBUILT_UI=1 so every artifact packages those
# exact bytes. Ordinary builds receive an ad-hoc signature; the tag workflow
# supplies Developer ID/notarization credentials for its final pass.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

# Rust debug metadata can otherwise disclose the checkout, Cargo cache, and
# toolchain locations even in an optimized bundle. Stable synthetic prefixes
# also make release archives independent of the builder's account name.
cargo_cache="${CARGO_HOME:-${HOME}/.cargo}"
rust_sysroot="$(rustc --print sysroot)"
cargo_target_dir="${CARGO_TARGET_DIR:-$root/desktop/src-tauri/target}"
case "$cargo_target_dir" in
  /*) ;;
  *) cargo_target_dir="$root/$cargo_target_dir" ;;
esac
export CARGO_TARGET_DIR="$cargo_target_dir"
# Current macOS requires a Mach-O LC_UUID to launch the application. The Apple
# linker changes that UUID when Cargo's absolute target path changes even after
# debug paths are remapped. The release workflow therefore clean-rebuilds at
# one stable target path; never trade launchability for a checksum.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$root=/wisp --remap-path-prefix=$cargo_cache=/cargo --remap-path-prefix=$rust_sysroot=/rust-toolchain --remap-path-prefix=$cargo_target_dir=/cargo-target"

case "${WISP_PREBUILT_UI:-0}" in
  0) bun run build:ui ;;
  1)
    test -f web/ui-dist/index.html || {
      echo "WISP_PREBUILT_UI=1 but web/ui-dist/index.html is missing" >&2
      exit 1
    }
    ;;
  *)
    echo "WISP_PREBUILT_UI must be 0 or 1" >&2
    exit 1
    ;;
esac
bash scripts/desktop/icons.sh

bundles=(app dmg)
if [ "${1:-}" = "--app-only" ]; then bundles=(app); fi

cd desktop/src-tauri
# Always use the pinned official npm distribution. A developer's unrelated
# global cargo-tauri/tauri executable must not change release bundle behavior.
tauri=(bun run tauri)
tauri_args=(
  build
  --target aarch64-apple-darwin
  --bundles "$(IFS=,; echo "${bundles[*]}")"
)
if [ -z "${APPLE_CERTIFICATE:-}" ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  # With no distribution credential Tauri otherwise leaves only the linker's
  # executable signature, which is not a valid signed application bundle.
  tauri_args+=(--config '{"bundle":{"macOS":{"signingIdentity":"-"}}}')
fi

"${tauri[@]}" "${tauri_args[@]}" -- --locked
