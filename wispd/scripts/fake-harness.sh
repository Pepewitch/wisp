#!/usr/bin/env bash
# Fake harness for wisp smoke tests: speaks the same shape as `droid exec -o json`.
# Behavior knobs are read from the PROMPT text (env doesn't reach daemon-spawned
# processes from the test shell): "sleep=N" and "exit=N" tokens.
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

if [[ -n "$fake_exit" && "$fake_exit" != "0" ]]; then
  echo "fake harness exploding as requested" >&2
  exit "$fake_exit"
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
# A non-image attachment is delivered by having its PATH named in the prompt,
# and the tail above cannot show it (the user's own message ends the prompt).
# Reporting it here is what lets the smoke prove delivery rather than storage.
# an `if`, not `cmd && assign`: under `set -e` a false compound ends the script
delivery=""
if grep -q 'attached to this message on disk' <<< "$prompt"; then
  delivery=" [path-delivered]"
fi
printf '{"result":"echo(turn on %s): %s%s","session_id":"%s"}\n' "$session" "$short" "$delivery" "$session"
