#!/usr/bin/env bash
# The desktop crate's gate: format, lint, and the full Rust test suite.
#
# Kept out of `bun run check` on purpose — that gate has to stay runnable on a
# machine with no Rust toolchain, and on the Linux CI runner where a macOS-only
# crate cannot build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$root"
bun run build:ui

cd desktop/src-tauri

cargo fmt --all --check
# `tauri-codegen` writes every target's compressed frontend asset to the same
# content-addressed path using a non-atomic exists/create sequence. Serializing
# this package's targets prevents one compiler from embedding another's partial
# Brotli stream. Keep this until upstream makes that write atomic.
cargo clippy --jobs 1 --all-targets --all-features -- -D warnings
cargo test --jobs 1 --locked
