#!/bin/bash
set -euo pipefail

handoff_dir="${WISP_EVALUATOR_HANDOFF_DIR:-/tmp}"
ready="$handoff_dir/wisp-evaluator-ready"
collected="$handoff_dir/wisp-evaluator-collected"
rm -f "$collected"
: > "$ready"

for _ in {1..1200}; do
  [[ ! -e "$collected" ]] || exit 0
  sleep 0.5
done

echo "evaluator evidence handoff timed out" >&2
exit 124
