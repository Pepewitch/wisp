#!/usr/bin/env bash
# Fake harness for wisp smoke tests: speaks the same shape as `droid exec -o json`.
# Behavior knobs are read from the PROMPT text (env doesn't reach daemon-spawned
# processes from the test shell): "sleep=N", "exit=N", "silent=1", and
# "limiterr=1" tokens.
# Args: [--session <id>] [--model <m>] <prompt>
#   (session/model flags injected by the adapter's resume/model templates)
set -euo pipefail

session=""
if [[ "${1:-}" == "--session" ]]; then
  session="$2"
  shift 2
fi
model=""
if [[ "${1:-}" == "--model" ]]; then
  model="$2"
  shift 2
fi
prompt="${1:-}"

fake_sleep=$(grep -oE 'sleep=[0-9]+' <<< "$prompt" | head -1 | cut -d= -f2 || true)
fake_exit=$(grep -oE 'exit=[0-9]+' <<< "$prompt" | head -1 | cut -d= -f2 || true)

sleep "${fake_sleep:-1}"

# limiterr=1: fail the way a real harness does on quota exhaustion — a
# limit-shaped error EVENT on stdout (droid's stream-json shape: droid's own
# stream-json consumer reads {"type":"error","message":…}, and its 402 text is
# "Unrecoverable 402: usage limit reached", per the droid 0.202.0 binary), then
# exit 1 with NOTHING on stderr — the case where a stderr tail would be blind.
if grep -q 'limiterr=1' <<< "$prompt"; then
  printf '{"type":"error","message":"Unrecoverable 402: usage limit reached"}\n'
  exit 1
fi

if [[ -n "$fake_exit" && "$fake_exit" != "0" ]]; then
  echo "fake harness exploding as requested" >&2
  exit "$fake_exit"
fi

# silent=1: exit 0 without emitting a result payload — the H3 quiet-liar case
if grep -q 'silent=1' <<< "$prompt"; then
  exit 0
fi

if [[ -z "$session" ]]; then
  session="fake-$RANDOM"
fi
# init event first, shaped like droid/claude's: announces the session and the
# model actually in use, so per-turn model capture (P5b) is exercised end to end
init_model=""
[[ -n "$model" ]] && init_model=',"model":"'"$model"'"'
printf '{"type":"system","subtype":"init","session_id":"%s"%s}\n' "$session" "$init_model"
short=$(printf '%s' "$prompt" | tail -c 80 | tr '\n' ' ' | tr -d '"\\')
printf '{"result":"echo(turn on %s): %s","session_id":"%s"}\n' "$session" "$short" "$session"
