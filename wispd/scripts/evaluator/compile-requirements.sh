#!/bin/sh
set -eu

required_uv=0.11.22
actual_uv="$(uv --version | awk 'NR == 1 { print $2 }')"
if [ "$actual_uv" != "$required_uv" ]; then
  echo "requirements.lock must be generated with uv $required_uv, got: ${actual_uv:-unknown}" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
exec uv pip compile wispd/scripts/evaluator/requirements.in \
  --generate-hashes --no-annotate --no-header \
  --python-version 3.12 --python-platform x86_64-manylinux_2_39 \
  --output-file wispd/scripts/evaluator/requirements.lock
