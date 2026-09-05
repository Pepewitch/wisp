#!/usr/bin/env bash
# Runs automatically when wisp creates a task worktree of THIS repo
# (.wisp/setup.sh contract): install dependencies so the harness can
# run `bun test` / `bunx tsc --noEmit` immediately. --frozen-lockfile keeps it
# reproducible and fails loudly on lockfile drift instead of silently
# resolving something else.
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
