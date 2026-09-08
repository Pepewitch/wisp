#!/bin/bash
set -euo pipefail

umask 077
export HOME=/home/evaluator
export PATH="/home/evaluator/bin:/home/evaluator/.local/bin:/opt/evaluator/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
export AGENT_BROWSER_SESSION="${WISP_EVALUATOR_BROWSER_SESSION:-wisp-evaluator}"
export AGENT_BROWSER_EXECUTABLE_PATH=/opt/chrome/chrome
export AGENT_BROWSER_PROXY="${HTTPS_PROXY:-}"
export AGENT_BROWSER_PROXY_BYPASS="127.0.0.1,localhost"
export AGENT_BROWSER_ALLOWED_DOMAINS="127.0.0.1,localhost"

mkdir -p "$HOME/bin" "$HOME/.local/bin" "$HOME/.factory" "$HOME/.wisp" /workspace/repo /evidence
ln -s /worktrees "$HOME/.wisp/worktrees"
cp -a /opt/evaluator/fixture/. /workspace/repo/
git init --separate-git-dir=/repo-git -b main /workspace/repo >/dev/null
git -C /workspace/repo config user.name "Wisp Evaluator"
git -C /workspace/repo config user.email "wisp-evaluator@example.invalid"
git -C /workspace/repo add .
git -C /workspace/repo commit -m "fixture: initial text filter" >/dev/null
git -C /workspace/repo rev-parse HEAD > /evidence/fixture-base-commit.txt

cat > "$HOME/.factory/settings.json" <<'JSON'
{
  "cloudSessionSync": false,
  "completionSound": "off",
  "awaitingInputSound": "off",
  "hooksDisabled": true,
  "enableDroidShield": true
}
JSON
chmod 0600 "$HOME/.factory/settings.json"

case "${WISP_EVALUATOR_MODE:-model}" in
  model)
    ln -s /opt/evaluator-tools/droid-wrapper.sh "$HOME/bin/droid"
    exec /opt/evaluator/run-model.sh
    ;;
  preflight)
    export WISP_EVALUATOR_OUTER_DROID=/opt/evaluator/fake-droid.py
    ln -s /opt/evaluator-tools/droid-wrapper.sh "$HOME/bin/droid"
    exec /opt/evaluator/run-preflight.py
    ;;
  *)
    echo "unknown evaluator mode: ${WISP_EVALUATOR_MODE:-}" >&2
    exit 2
    ;;
esac
