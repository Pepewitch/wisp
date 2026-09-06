#!/usr/bin/env bash
# The desktop crate's gate: format, lint, and the full Rust test suite.
#
# Kept out of `bun run check` on purpose — that gate has to stay runnable on a
# machine with no Rust toolchain, and on the Linux CI runner where a macOS-only
# crate cannot build.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/desktop/src-tauri"

cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --locked
