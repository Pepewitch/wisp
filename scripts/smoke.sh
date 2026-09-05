#!/usr/bin/env bash
# End-to-end smoke test using the fake harness. No agent tokens burned.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
WISP="bun $ROOT/src/index.ts"

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
    "exec": ["$ROOT/scripts/fake-harness.sh"],
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

echo "[2b] active send preserves the turn and drains as the next FIFO turn"
OUTQ=$($WISP new "$REPO" "finish this first sleep=4" --harness fake)
IDQ=$(echo "$OUTQ" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$IDQ" running 20
SENDQ=$($WISP send "$IDQ" "queued correction")
grep -q "queued for the next turn" <<< "$SENDQ" || fail "active fallback send did not report queued-next: $SENDQ"
$WISP show "$IDQ" | grep -q '— turn 1 \[running\]' || fail "active send interrupted the original turn"
for i in $(seq 1 40); do
  SHOWQ=$($WISP show "$IDQ")
  [[ "$(grep -c '^— turn' <<< "$SHOWQ" || true)" == "2" ]] &&
    grep -q '— turn 1 \[done\]' <<< "$SHOWQ" &&
    grep -q '— turn 2 \[done\]' <<< "$SHOWQ" &&
    grep -q "queued correction" <<< "$SHOWQ" &&
    break
  [[ $i == 40 ]] && fail "queued active message did not drain into one later turn: $SHOWQ"
  sleep 0.5
done

echo "[3] loud spawn failure"
OUT2=$($WISP new "$REPO" "this should fail loudly" --harness missing)
ID2=$(echo "$OUT2" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID2" failed 20
$WISP ls | grep "$ID2" | grep -q "spawn failed" || fail "failure reason not surfaced in ls"

echo "[4] failed harness turn (nonzero exit)"
OUT3=$($WISP new "$REPO" "exploding harness exit=3" --harness fake)
ID3=$(echo "$OUT3" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID3" failed 30
$WISP ls | grep "$ID3" | grep -q "exited 3" || fail "exit code not surfaced"

echo "[4b] --image end to end: stored, listed, served by the bytes route, gone after archive"
# a real 1x1 PNG: the daemon sniffs magic bytes, so a fake one would be rejected
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\x2d\xb4\x00\x00\x00\x00IEND\xaeB\x60\x82' > "$SMOKE/shot.png"
OUTI=$($WISP new "$REPO" "look at this" --harness fake --image "$SMOKE/shot.png")
IDI=$(echo "$OUTI" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$IDI" done 30
$WISP show "$IDI" | grep -q "attached: shot.png" || fail "wisp show did not list the attachment"
# the honest line lands in the turn log before any harness output
$WISP log "$IDI" --raw | grep -q '· attached: shot.png' || fail "attach note missing from the log"
BYTES="http://127.0.0.1:$PORT/api/tasks/$IDI/attachments/1/shot.png"
CT=$(curl -sf -o "$SMOKE/served.png" -w '%{content_type}' -H "authorization: Bearer smoketoken" "$BYTES") \
  || fail "bytes route did not serve the attachment"
[[ "$CT" == "image/png" ]] || fail "content-type came from the name, not the bytes (got: $CT)"
cmp -s "$SMOKE/shot.png" "$SMOKE/served.png" || fail "served bytes differ from the stored file"
# a name the turn's manifest does not list is a 404, whatever the filesystem says
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer smoketoken" \
  "http://127.0.0.1:$PORT/api/tasks/$IDI/attachments/1/ghost.png")
[[ "$CODE" == "404" ]] || fail "an unlisted attachment name should 404 (got: $CODE)"
$WISP archive "$IDI" | grep -q archived || fail "archive of an attached task failed"
# archive deletes the bytes and KEEPS the manifest: 410, and the record still reads
for i in $(seq 1 40); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer smoketoken" "$BYTES")
  [[ "$CODE" == "410" ]] && break
  sleep 0.25
done
[[ "$CODE" == "410" ]] || fail "archived attachment should be 410 gone (got: $CODE)"
$WISP show "$IDI" | grep -q "removed when this task was archived" \
  || fail "the archived turn forgot it ever carried an image"

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

echo "[8] interrupt after restart (re-adopted turn — the process.kill fallback)"
OUT6=$($WISP new "$REPO" "interrupt after restart sleep=60" --harness fake)
ID6=$(echo "$OUT6" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID6" running 20
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
$WISP serve >> "$SMOKE/daemon.log" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.3; done
grep -q "re-adopted task $ID6" "$SMOKE/daemon.log" || fail "live turn was not re-adopted"
# no liveChildren entry exists for a re-adopted turn, so interrupt must signal the persisted pid
$WISP interrupt "$ID6" > /dev/null
wait_state "$ID6" needs-input 30
$WISP show "$ID6" | grep -q '— turn 1 \[interrupted\]' || fail "re-adopted turn not marked interrupted"

echo "[9] webhook outbox drains (delivery loop ticks every 5s)"
for i in $(seq 1 20); do
  COUNT=$(curl -sf -H "authorization: Bearer smoketoken" "http://127.0.0.1:$PORT/api/outbox" | grep -c task_id || true)
  [[ "$COUNT" == "0" ]] && break
  sleep 1
done
[[ "$COUNT" == "0" ]] || fail "outbox still has $COUNT undelivered rows after 20s"

echo "[10] interrupt a running turn, then steer"
OUT6=$($WISP new "$REPO" "long task sleep=60" --harness fake)
ID6=$(echo "$OUT6" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID6" running 20
$WISP interrupt "$ID6" > /dev/null
wait_state "$ID6" needs-input 20
$WISP show "$ID6" | grep -q 'turn 1 \[interrupted\]' || fail "turn not marked interrupted"
$WISP send "$ID6" "corrected instruction" > /dev/null
wait_state "$ID6" done 30

echo "[11] force-archive kills the running turn and marks it interrupted"
OUT7=$($WISP new "$REPO" "doomed task sleep=60" --harness fake)
ID7=$(echo "$OUT7" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID7" running 20
if $WISP archive "$ID7" 2>/dev/null; then fail "archive should have refused a running turn without force"; fi
$WISP archive "$ID7" -f | grep -q archived || fail "force archive of running task failed"
$WISP ls | grep -q "$ID7" && fail "force-archived task still listed"
WT7=$($WISP show "$ID7" | sed -n 's/^worktree: //p')
[[ -n "$WT7" ]] || fail "could not read worktree path of archived task"
# Everything destructive is DELIBERATELY behind the response (Q11): the refusals
# are synchronous, the killing and removing are not. So these two are polled
# rather than asserted once — and the poll is the assertion that the background
# job actually runs, not a workaround for it.
for i in $(seq 1 60); do
  $WISP show "$ID7" | grep -q 'turn 1 \[interrupted\]' && [[ ! -e "$WT7" ]] && break
  sleep 0.25
done
$WISP show "$ID7" | grep -q 'turn 1 \[interrupted\]' || fail "turn not marked interrupted by force-archive"
[[ -e "$WT7" ]] && fail "worktree still exists after force-archive teardown finished"

echo "[12] startup sweep fails tasks wedged in 'creating' (daemon killed mid-setup)"
REPO2="$SMOKE/repo2"
mkdir -p "$REPO2/.wisp"
git -C "$REPO2" init -q
printf '#!/usr/bin/env bash\nsleep 30\n' > "$REPO2/.wisp/setup.sh"
git -C "$REPO2" add .
git -C "$REPO2" -c user.email=smoke@wisp -c user.name=smoke commit -q -m "add slow setup"
OUT8=$($WISP new "$REPO2" "wedge me in creating" --harness fake)
ID8=$(echo "$OUT8" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID8" creating 10  # setup.sh (sleep 30) is running
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
$WISP serve >> "$SMOKE/daemon.log" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.3; done
wait_state "$ID8" failed 20
$WISP ls | grep "$ID8" | grep -q "being created" || fail "sweep failure reason not surfaced in ls"

echo "[13] hung setup.sh is killed by setupTimeoutMinutes and fails the task"
cat > "$WISP_HOME/config.json" <<EOF
{ "port": $PORT, "host": "127.0.0.1", "token": "smoketoken", "webhooks": [],
  "stuckMinutes": 10, "logMaxBytes": 5000000, "setupTimeoutMinutes": 0.05, "envAllowlist": {},
  "harnessDefaults": { "fake": { "model": "fake-7b" } } }
EOF
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
$WISP serve >> "$SMOKE/daemon.log" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.3; done
OUT9=$($WISP new "$REPO2" "setup hangs forever" --harness fake)
ID9=$(echo "$OUT9" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID9" failed 30  # 0.05 min = 3s timeout on a 30s setup
$WISP ls | grep "$ID9" | grep -q "timed out" || fail "setup timeout reason not surfaced in ls"

echo "[14] exit 0 with no result payload fails loudly (spawn contract, H3)"
OUT10=$($WISP new "$REPO" "quiet liar silent=1" --harness fake)
ID10=$(echo "$OUT10" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID10" failed 30
$WISP ls | grep "$ID10" | grep -q "no parseable result" || fail "H3 failure reason not surfaced in ls"

echo "[15] wisp wait blocks until a task settles, with state-coded exit statuses"
OUT11=$($WISP new "$REPO" "wait for me sleep=3" --harness fake)
ID11=$(echo "$OUT11" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
RC=0
WOUT=$($WISP wait "$ID11" --timeout 60) || RC=$?
[[ "$RC" == "0" ]] || fail "wait on a task that finished should exit 0, got $RC ($WOUT)"
[[ "$(printf '%s\n' "$WOUT" | wc -l | tr -d ' ')" == "1" ]] || fail "wait printed more than one line: $WOUT"
grep -q "^$ID11  done" <<< "$WOUT" || fail "wait did not print the settled state line (got: $WOUT)"

RC=0
WOUT=$($WISP wait "$ID11" --timeout 60) || RC=$?  # already settled: returns immediately
[[ "$RC" == "0" ]] || fail "wait on an already-done task should exit 0, got $RC"

echo "[16] wait exits 3 on timeout, 2 on needs-input, 1 on failed"
OUT12=$($WISP new "$REPO" "never finishes sleep=60" --harness fake)
ID12=$(echo "$OUT12" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID12" running 20  # so the interrupt below has a turn to stop
RC=0
WOUT=$($WISP wait "$ID12" --timeout 3) || RC=$?
[[ "$RC" == "3" ]] || fail "wait should exit 3 on timeout, got $RC ($WOUT)"
grep -q "timeout after 3s" <<< "$WOUT" || fail "timeout line not loud about the timeout: $WOUT"
$WISP interrupt "$ID12" > /dev/null
RC=0
WOUT=$($WISP wait "$ID12" --timeout 30) || RC=$?
[[ "$RC" == "2" ]] || fail "wait should exit 2 on needs-input, got $RC ($WOUT)"
OUT13=$($WISP new "$REPO" "doomed wait exit=4" --harness fake)
ID13=$(echo "$OUT13" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
RC=0
WOUT=$($WISP wait "$ID13" --timeout 30) || RC=$?
[[ "$RC" == "1" ]] || fail "wait should exit 1 on failed, got $RC ($WOUT)"
grep -q "exited 4" <<< "$WOUT" || fail "wait line does not carry state_detail: $WOUT"

echo "[17] END-TO-END webhook: a real receiver gets the done event (the openclaw path)"
RECV_PORT=8792
RECV_FILE="$SMOKE/webhook-received.jsonl"
: > "$RECV_FILE"
# stub consumer: appends every POST body to a file, answers GET as a readiness probe
RECV_PORT=$RECV_PORT RECV_FILE=$RECV_FILE bun -e '
import { appendFileSync } from "node:fs";
Bun.serve({
  port: Number(process.env.RECV_PORT),
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method !== "POST") return new Response("up");
    appendFileSync(process.env.RECV_FILE, (await req.text()) + "\n");
    return new Response("ok");
  },
});
' > "$SMOKE/receiver.log" 2>&1 &
RECV_PID=$!
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$RECV_PORT/" > /dev/null && break
  [[ $i == 30 ]] && fail "stub webhook receiver did not come up: $(cat "$SMOKE/receiver.log")"
  sleep 0.3
done
# point wisp at the receiver and restart the daemon (webhooks are read at boot)
cat > "$WISP_HOME/config.json" <<EOF
{ "port": $PORT, "host": "127.0.0.1", "token": "smoketoken",
  "webhooks": ["http://127.0.0.1:$RECV_PORT/wisp"],
  "stuckMinutes": 10, "logMaxBytes": 5000000, "envAllowlist": {},
  "harnessDefaults": { "fake": { "model": "fake-7b" } } }
EOF
kill "$DAEMON_PID"; wait "$DAEMON_PID" 2>/dev/null || true
$WISP serve >> "$SMOKE/daemon.log" 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.3; done
OUT14=$($WISP new "$REPO" "notify a real consumer" --harness fake)
ID14=$(echo "$OUT14" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
RC=0
$WISP wait "$ID14" --timeout 60 > /dev/null || RC=$?
[[ "$RC" == "0" ]] || fail "webhook task did not reach done (wait exit $RC)"
# outbox loop ticks every 5s; give it a few of those before calling it a miss
for i in $(seq 1 20); do
  grep "$ID14" "$RECV_FILE" 2>/dev/null | grep -q '"state":"done"' && break
  [[ $i == 20 ]] && fail "receiver never got the done event for $ID14 (got: $(cat "$RECV_FILE"))"
  sleep 1
done
EVENT=$(grep "$ID14" "$RECV_FILE" | grep '"state":"done"' | head -1)
grep -q '"seq":' <<< "$EVENT" || fail "delivered event has no seq to dedup on: $EVENT"
grep -q '"harness":"fake"' <<< "$EVENT" || fail "delivered event does not name the harness: $EVENT"
# and the row is retired, so the receiver is not re-POSTed forever
for i in $(seq 1 20); do
  COUNT=$(curl -sf -H "authorization: Bearer smoketoken" "http://127.0.0.1:$PORT/api/outbox" | grep -c task_id || true)
  [[ "$COUNT" == "0" ]] && break
  sleep 1
done
[[ "$COUNT" == "0" ]] || fail "outbox still has $COUNT undelivered rows after a live receiver accepted them"
kill "$RECV_PID"; RECV_PID=""

echo "[18] limit-shaped failure: state_detail is prefixed 'limit: ' and names the cause"
OUT15=$($WISP new "$REPO" "hit the quota wall limiterr=1" --harness fake)
ID15=$(echo "$OUT15" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID15" failed 30
SHOW15=$($WISP show "$ID15")
grep -q "limit: turn exited 1" <<< "$SHOW15" || fail "limit failure not prefixed 'limit: ': $(head -1 <<< "$SHOW15")"
grep -q "usage limit reached" <<< "$SHOW15" || fail "limit cause not named in state_detail: $(head -1 <<< "$SHOW15")"
# and a plain failure (scenario 4) must NOT carry the prefix
SHOW3=$($WISP show "$ID3")
grep -q "limit:" <<< "$(head -1 <<< "$SHOW3")" && fail "non-limit failure wrongly classified as limit: $(head -1 <<< "$SHOW3")"

echo "[19] config harnessDefaults supply the model; turns report the model they ACTUALLY ran on (P5b)"
OUT16=$($WISP new "$REPO" "default model task" --harness fake)
ID16=$(echo "$OUT16" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
grep -q "fake, fake-7b" <<< "$OUT16" || fail "created line does not show the applied default model: $OUT16"
wait_state "$ID16" done 30
$WISP show "$ID16" | grep -q "harness: fake (fake-7b)" || fail "config default model not applied to the task"
$WISP show "$ID16" | grep -q '— turn 1 \[done\] · fake-7b' || fail "turn did not record the model it ran on"
LSLINE=$($WISP ls | grep "$ID16")
grep -q "fake-7b turn" <<< "$LSLINE" || fail "ls does not show the latest turn's actual model: $LSLINE"
grep -q "(requested)" <<< "$LSLINE" && fail "a model the harness reported must not be marked (requested): $LSLINE"

echo "[20] an explicit --model always wins over the config default (P5b)"
OUT17=$($WISP new "$REPO" "flag wins task" --harness fake --model fake-flag-9)
ID17=$(echo "$OUT17" | sed -n 's/^created \(t[a-z0-9]*\).*/\1/p')
wait_state "$ID17" done 30
$WISP show "$ID17" | grep -q "harness: fake (fake-flag-9)" || fail "explicit --model did not win over the config default"
$WISP show "$ID17" | grep -q '— turn 1 \[done\] · fake-flag-9' || fail "turn ran on the config default instead of the flag"

echo
echo "SMOKE PASS ($SMOKE)"
