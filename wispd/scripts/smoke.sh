#!/usr/bin/env bash
# End-to-end smoke test using the fake harness. No agent tokens burned.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -n "${SMOKE_DIR:-}" ]]; then
  SMOKE="$SMOKE_DIR/wisp-smoke-$$"
  REMOVE_SMOKE=0
else
  SMOKE="$(mktemp -d "${TMPDIR:-/tmp}/wisp-smoke.XXXXXX")"
  REMOVE_SMOKE=1
fi
export WISP_HOME="$SMOKE/home"
mkdir -p "$WISP_HOME"
PORT="$(bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}}); console.log(s.port); s.stop(true)')"
WISP="bun $ROOT/wispd/src/index.ts"

cleanup() {
  [[ -n "${DAEMON_PID:-}" ]] && kill "$DAEMON_PID" 2>/dev/null || true
  [[ -n "${RECV_PID:-}" ]] && kill "$RECV_PID" 2>/dev/null || true
  [[ "$REMOVE_SMOKE" -eq 0 ]] || rm -rf "$SMOKE"
}
# On ANY failure — including set -e deaths that bypass fail() (e.g. the
# scenario-7/8 `kill` finding the daemon already gone, seen flaking twice) —
# dump the daemon log so the postmortem has evidence.
on_exit() {
  rc=$?
  if [[ $rc -ne 0 && -f "${SMOKE}/daemon.log" ]]; then
    echo "--- daemon log (smoke exited $rc) ---" >&2
    cat "$SMOKE/daemon.log" >&2
  fi
  cleanup
}
trap on_exit EXIT

fail() { echo "SMOKE FAIL: $1" >&2; echo "--- daemon log ---" >&2; cat "$SMOKE/daemon.log" >&2 || true; exit 1; }

cat > "$WISP_HOME/config.json" <<EOF
{ "port": $PORT, "host": "127.0.0.1", "token": "smoketoken", "webhooks": [],
  "stuckMinutes": 10, "logMaxBytes": 5000000, "envAllowlist": {},
  "harnessDefaults": { "fake": { "model": "fake-7b" } } }
EOF
cat > "$WISP_HOME/adapters.json" <<EOF
{
  "fake": {
    "bin": "bash",
    "exec": ["$ROOT/wispd/scripts/fake-harness.sh"],
    "resume": ["--session", "{session}"],
    "model": ["--model", "{model}"],
    "image": ["-i", "{path}", "--"],
    "parse": { "format": "json", "result": "result", "session": "session_id", "model": "model" },
    "errors": "droid-stream-json",
    "limitMarkers": ["usage limit"],
    "attach": null
  },
  "missing": {
    "bin": "definitely-not-a-real-binary-xyz",
    "exec": [],
    "parse": { "format": "text" },
    "attach": null
  }
}
EOF

# throwaway repo
REPO="$SMOKE/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" -c user.email=smoke@wisp -c user.name=smoke commit -q --allow-empty -m init

# daemon
$WISP serve > "$SMOKE/daemon.log" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break
  [[ $i == 30 ]] && fail "daemon did not come up"
  sleep 0.3
done

state_of() { $WISP show "$1" 2>/dev/null | head -1 | awk '{print $2}'; }
wait_state() { # id, want, tries
  for i in $(seq 1 "$3"); do
    s=$(state_of "$1")
    [[ "$s" == "$2" ]] && return 0
    sleep 0.5
  done
  fail "task $1 never reached '$2' (last: $s)"
}

# What only an end-to-end run proves: the real CLI talking to a real daemon
# that spawns a real subprocess harness in a real worktree, and the restart
# promise. Everything else this script used to walk through (queued sends,
# attachments, storage and purge previews, webhooks, force-archive, setup
# timeouts, the startup sweep, limit detection, harness defaults, search) is
# owned by the daemon suite, which proves it faster and without sleeps.

echo "[1] create task, expect done"
OUT=$($WISP new "$REPO" "hello wisp turn one" --harness fake)
ID=$(echo "$OUT" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
[[ -n "$ID" ]] || fail "could not parse task id from: $OUT"
wait_state "$ID" done 30

echo "[2] session threading across turns"
SESSION1=$($WISP show "$ID" | sed -n 's/.*session: \(.*\)/\1/p' | head -1)
[[ "$SESSION1" == fake-* ]] || fail "no session captured (got: $SESSION1)"
$WISP send "$ID" "turn two please" > /dev/null
wait_state "$ID" done 30
$WISP show "$ID" | grep -q "echo(turn on $SESSION1)" || fail "turn 2 did not resume session $SESSION1"
TURNS=$($WISP show "$ID" | grep -c '^— turn' || true)
[[ "$TURNS" == "2" ]] || fail "expected 2 turns, got $TURNS"

echo "[3] loud spawn failure"
OUT2=$($WISP new "$REPO" "this should fail loudly" --harness missing)
ID2=$(echo "$OUT2" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID2" failed 20
$WISP ls | grep "$ID2" | grep -q "spawn failed" || fail "failure reason not surfaced in ls"

RC=0
WOUT=$($WISP wait "$ID2" --timeout 30) || RC=$?
[[ "$RC" == "1" ]] || fail "wait should exit 1 on failed, got $RC ($WOUT)"
grep -q "spawn failed" <<< "$WOUT" || fail "wait line does not carry state_detail: $WOUT"

echo "[5] archive clean task"
$WISP archive "$ID" | grep -q archived || fail "archive failed"
$WISP ls | grep -q "$ID" && fail "archived task still listed"

echo "[6] archive refuses on dirty worktree, force commits the work onto the branch"
OUT4=$($WISP new "$REPO" "dirty task" --harness fake)
ID4=$(echo "$OUT4" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID4" done 30
WT=$($WISP show "$ID4" | sed -n 's/^worktree: //p')
echo "uncommitted" > "$WT/dirty.txt"
if $WISP archive "$ID4" 2>/dev/null; then fail "archive should have refused dirty worktree"; fi
$WISP archive "$ID4" --force | grep -q archived || fail "force archive failed"

echo "[10] interrupt a running turn, then steer; wisp wait exits 3 on timeout, 2 on needs-input, 0 on done"
OUT6=$($WISP new "$REPO" "long task sleep=60" --harness fake)
ID6=$(echo "$OUT6" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID6" running 20
RC=0
WOUT=$($WISP wait "$ID6" --timeout 1) || RC=$?
[[ "$RC" == "3" ]] || fail "wait should exit 3 on timeout, got $RC ($WOUT)"
grep -q "timeout after 1s" <<< "$WOUT" || fail "timeout line not loud about the timeout: $WOUT"
$WISP interrupt "$ID6" > /dev/null
RC=0
WOUT=$($WISP wait "$ID6" --timeout 20) || RC=$?
[[ "$RC" == "2" ]] || fail "wait should exit 2 on needs-input, got $RC ($WOUT)"
$WISP show "$ID6" | grep -q 'turn 1 \[interrupted\]' || fail "turn not marked interrupted"
$WISP send "$ID6" "corrected instruction" > /dev/null
RC=0
WOUT=$($WISP wait "$ID6" --timeout 30) || RC=$?
[[ "$RC" == "0" ]] || fail "wait on a task that finished should exit 0, got $RC ($WOUT)"
[[ "$(printf '%s\n' "$WOUT" | wc -l | tr -d ' ')" == "1" ]] || fail "wait printed more than one line: $WOUT"
grep -q "^$ID6  done" <<< "$WOUT" || fail "wait did not print the settled state line (got: $WOUT)"

echo "[7] LIVE re-adoption: daemon killed mid-turn, live-pid poll loop finalizes after restart"
OUT5=$($WISP new "$REPO" "survive a live restart sleep=8" --harness fake)
ID5=$(echo "$OUT5" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
sleep 2  # turn is now running — and stays running: the fake harness sleeps 8s
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
# restart IMMEDIATELY, while the harness is still mid-turn — this exercises the
# live-pid poll loop, not the dead-pid finalize path
$WISP serve >> "$SMOKE/daemon.log" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.3; done
grep -q "re-adopted task $ID5" "$SMOKE/daemon.log" || fail "live turn was not re-adopted"
# the 3s poll notices the harness exit and finalizes (exit code unknown → judged by parseable output)
wait_state "$ID5" done 40
$WISP show "$ID5" | grep -q '— turn 1 \[done\]' || fail "re-adopted turn not finalized as done"

echo
echo "SMOKE PASS ($SMOKE)"
