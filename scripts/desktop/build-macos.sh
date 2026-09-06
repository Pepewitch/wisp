#!/usr/bin/env bash
# Build the Wisp desktop .app for Apple Silicon macOS.
#
#   bash scripts/desktop/build-macos.sh            # .app + .dmg
#   bash scripts/desktop/build-macos.sh --app-only # skip the .dmg
#
# The webview loads the same committed web/ui-dist bundle the daemon serves, so
# this refreshes it first. The whole app bundle receives an ad-hoc signature;
# Developer ID signing and Apple notarization remain separate release work.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

# Rust debug metadata can otherwise disclose the checkout, Cargo cache, and
# toolchain locations even in an optimized bundle. Stable synthetic prefixes
# also make release archives independent of the builder's account name.
cargo_cache="${CARGO_HOME:-${HOME}/.cargo}"
rust_sysroot="$(rustc --print sysroot)"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$root=/wisp --remap-path-prefix=$cargo_cache=/cargo --remap-path-prefix=$rust_sysroot=/rust-toolchain"

bun run build:ui
bash scripts/desktop/icons.sh

bundles=(app dmg)
if [ "${1:-}" = "--app-only" ]; then bundles=(app); fi

cd desktop/src-tauri
# Always use the pinned official npm distribution. A developer's unrelated
# global cargo-tauri/tauri executable must not change release bundle behavior.
tauri=(bunx --bun @tauri-apps/cli@2.11.4)

"${tauri[@]}" build --target aarch64-apple-darwin --bundles "$(IFS=,; echo "${bundles[*]}")" -- --locked
