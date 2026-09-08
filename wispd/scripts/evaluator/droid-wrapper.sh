#!/bin/bash
set -euo pipefail

OUTER_DROID="${WISP_EVALUATOR_OUTER_DROID:-/opt/evaluator/node_modules/.bin/droid}"
INNER_CLIENT="${WISP_EVALUATOR_INNER_CLIENT:-/opt/evaluator-tools/inner-client.py}"

if [[ -z "${WISP_TASK_ID:-}" ]]; then
  exec "$OUTER_DROID" "$@"
fi

: "${WISP_WORKTREE:?WISP_WORKTREE is required for an inner Droid process}"
exec "$INNER_CLIENT" "$@"
