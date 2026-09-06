#!/usr/bin/env bash
# Build the Wisp desktop .app for Apple Silicon macOS.
#
#   bash scripts/desktop/build-macos.sh            # .app + .dmg
#   bash scripts/desktop/build-macos.sh --app-only # skip the .dmg
#
# The webview loads the same committed web/ui-dist bundle the daemon serves, so
# this refreshes it first. No signing identity is configured: the output is an
# unsigned local build, and Gatekeeper is left exactly as it is on the machine.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

bun run build:ui
bash scripts/desktop/icons.sh

bundles=(app dmg)
if [ "${1:-}" = "--app-only" ]; then bundles=(app); fi

cd desktop/src-tauri
if command -v cargo-tauri >/dev/null 2>&1; then
  tauri=(cargo tauri)
elif command -v tauri >/dev/null 2>&1; then
  tauri=(tauri)
else
  # Official npm distribution of the same CLI; no lockfile entry needed.
  tauri=(bunx --bun @tauri-apps/cli@2)
fi

"${tauri[@]}" build --target aarch64-apple-darwin --bundles "$(IFS=,; echo "${bundles[*]}")"
