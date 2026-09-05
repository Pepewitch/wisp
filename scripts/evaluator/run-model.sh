#!/bin/bash
set -uo pipefail

model="${WISP_EVALUATOR_MODEL:?WISP_EVALUATOR_MODEL is required}"
effort="${WISP_EVALUATOR_EFFORT:?WISP_EVALUATOR_EFFORT is required}"
timeout_seconds="${WISP_EVALUATOR_TIMEOUT_SECONDS:-1200}"

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$started_at" > /evidence/started-at.txt
rm -f /tmp/wisp-evaluator-ready /tmp/wisp-evaluator-collected

# Start a fresh contained browser before the model runs so viewport and HAR
# capture are evaluator facts rather than self-reported model behavior.
browser_ready=0
python3 -m http.server 8709 --bind 127.0.0.1 --directory /tmp \
  >/evidence/browser-bootstrap-server.log 2>&1 &
bootstrap_server=$!
for _ in {1..50}; do
  curl --fail --silent http://127.0.0.1:8709/ >/dev/null 2>&1 && break
  sleep 0.1
done
if agent-browser open http://127.0.0.1:8709/ >/evidence/browser-bootstrap.log 2>&1 \
  && agent-browser set viewport 390 844 >>/evidence/browser-bootstrap.log 2>&1 \
  && agent-browser network har start --content none >>/evidence/browser-bootstrap.log 2>&1; then
  browser_ready=1
fi
kill "$bootstrap_server" >/dev/null 2>&1 || true
wait "$bootstrap_server" 2>/dev/null || true

droid doctor --auth --json --timeout 5000 > /evidence/droid-auth.json 2>/evidence/droid-auth.stderr
auth_exit=$?

model_pid=""
evidence_live=0
if [ "$auth_exit" -eq 0 ]; then
  timeout --signal=TERM --kill-after=30 "$timeout_seconds" \
    droid exec \
      --cwd /workspace \
      --model "$model" \
      --reasoning-effort "$effort" \
      --output-format stream-json \
      --skip-permissions-unsafe \
      --file /opt/evaluator/prompt.md \
      > /evidence/model.jsonl \
      2> /evidence/model.stderr &
  model_pid=$!
  while kill -0 "$model_pid" >/dev/null 2>&1; do
    if [ -e /tmp/wisp-evaluator-ready ]; then
      evidence_live=1
      break
    fi
    sleep 0.25
  done
else
  model_exit=125
  : > /evidence/model.jsonl
  printf 'model execution skipped because Droid auth preflight exited %s\n' "$auth_exit" \
    > /evidence/model.stderr
fi

printf '%s\n' "$auth_exit" > /evidence/auth-exit.txt
printf '%s\n' "$browser_ready" > /evidence/browser-ready.txt

if [ "$evidence_live" -eq 1 ]; then
  # The model is blocked in wisp-evaluator-handoff, so its daemon and browser
  # are still alive. Record a provisional success, capture objective state,
  # then release the model and replace the provisional exit with the real one.
  printf '0\n' > /evidence/model-exit.txt
  date -u +%Y-%m-%dT%H:%M:%SZ > /evidence/finished-at.txt
  /opt/evaluator/collect-evidence.py
  oracle_exit=$?
  : > /tmp/wisp-evaluator-collected
fi

if [ -n "$model_pid" ]; then
  wait "$model_pid"
  model_exit=$?
fi
printf '%s\n' "$model_exit" > /evidence/model-exit.txt

if [ "$evidence_live" -eq 0 ]; then
  date -u +%Y-%m-%dT%H:%M:%SZ > /evidence/finished-at.txt
  /opt/evaluator/collect-evidence.py
  oracle_exit=$?
elif [ "$model_exit" -ne 0 ] && [ -f /evidence/case.json ]; then
  python3 - "$model_exit" <<'PY'
import json
import sys
from pathlib import Path

path = Path("/evidence/case.json")
case = json.loads(path.read_text(encoding="utf-8"))
exit_code = int(sys.argv[1])
case["process"]["modelExit"] = exit_code
for oracle in case["oracles"]:
    if oracle["name"] == "model process":
        oracle["status"] = "fail"
        oracle["detail"] = f"exit {exit_code}"
case["verdict"] = "fail"
path.write_text(json.dumps(case, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  oracle_exit=1
fi

/opt/evaluator/redact-evidence.py

# Preserve both facts: infrastructure/oracle failure wins, then model failure.
if [ "$oracle_exit" -ne 0 ]; then
  exit "$oracle_exit"
fi
exit "$model_exit"
