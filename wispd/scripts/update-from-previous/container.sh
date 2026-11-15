#!/bin/bash
# Runs inside the update-from-previous container (see run.sh): install the
# previous release with its own installer, supervise it with Supervisor the
# way docs/INSTALL.md documents, give it state, run its own `wisp update`,
# and check that the candidate came back with that state intact.
set -euo pipefail

: "${PREVIOUS:?}" "${PREVIOUS_SHA256:?}" "${CANDIDATE:?}" "${CANDIDATE_COMMIT:?}"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
INSTALL_ROOT="$HOME/.local/share/wisp"
DAEMON_LOG="$HOME/wisp-daemon.log"

diagnostics() {
  echo "--- supervisord log" >&2
  cat "$HOME/supervisord.log" >&2 2>/dev/null || true
  echo "--- daemon log" >&2
  cat "$DAEMON_LOG" >&2 2>/dev/null || true
  echo "--- install root" >&2
  ls -la "$INSTALL_ROOT" "$INSTALL_ROOT/versions" >&2 2>/dev/null || true
  if test -r "$HOME/.wisp/update-last.json"; then
    echo "--- last update attempt" >&2
    cat "$HOME/.wisp/update-last.json" >&2
  fi
}
fail() {
  diagnostics
  echo "update-from-previous: $*" >&2
  exit 1
}
stop_supervisor() {
  if test -s "$HOME/supervisord.pid"; then
    kill "$(cat "$HOME/supervisord.pid")" 2>/dev/null || true
  fi
}
trap stop_supervisor EXIT

health_field() {
  curl --silent --show-error --fail --max-time 5 "http://127.0.0.1:$PORT/api/health" |
    python3 -I -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

# 1. The previous release, installed by the installer it shipped with.
WISP_VERSION="$PREVIOUS" WISP_ARTIFACT_PATH=/release/previous WISP_SHA256="$PREVIOUS_SHA256" \
  WISP_INSTALL_SERVICE=no /bin/sh /install.sh >"$HOME/install.log" ||
  { cat "$HOME/install.log" >&2; fail "the $PREVIOUS installer failed"; }
wisp version --json | grep -q "\"version\":\"$PREVIOUS\"" || fail "installed CLI is not $PREVIOUS"
PORT="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["port"])' "$HOME/.wisp/config.json")"

# 2. Supervisor, configured as docs/INSTALL.md documents it. Two test-only
# additions: the daemon trusts the throwaway CA the mirror presents
# (NODE_EXTRA_CA_CERTS, read by the Bun runtime, not by Wisp), and its output
# goes to a known file. supervisorctl, which the daemon runs to confirm its
# PID, finds this file because the program runs with its directory as cwd.
cat >"$HOME/supervisord.conf" <<EOF
[unix_http_server]
file=$HOME/supervisor.sock
chmod=0700

[supervisord]
logfile=$HOME/supervisord.log
pidfile=$HOME/supervisord.pid
childlogdir=$HOME

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://$HOME/supervisor.sock

[program:wisp]
command=%(ENV_HOME)s/.local/bin/wisp serve
directory=%(ENV_HOME)s
umask=077
autostart=true
autorestart=true
startsecs=5
stopasgroup=false
killasgroup=false
environment=HOME="%(ENV_HOME)s",PATH="%(ENV_HOME)s/.local/bin:/usr/local/bin:/usr/bin:/bin",WISP_UPDATE_SUPERVISOR="supervisord",NODE_EXTRA_CA_CERTS="/certs/ca.pem"
redirect_stderr=true
stdout_logfile=$DAEMON_LOG
EOF
cd "$HOME"
supervisord -c "$HOME/supervisord.conf" || fail "supervisord did not start"

wait_running() {
  # startsecs=5 means RUNNING is reported only after five healthy seconds.
  for _ in $(seq 1 150); do
    if supervisorctl status wisp 2>/dev/null | grep -q "RUNNING"; then return 0; fi
    sleep 0.2
  done
  return 1
}
wait_running || fail "Supervisor did not report the $PREVIOUS daemon RUNNING"
for _ in $(seq 1 100); do
  [ "$(health_field version 2>/dev/null)" = "$PREVIOUS" ] && break
  sleep 0.2
done
[ "$(health_field version)" = "$PREVIOUS" ] || fail "the $PREVIOUS daemon did not answer /api/health"
OLD_PID="$(supervisorctl pid wisp)"

# 3. State written by the previous release, to be read back by the candidate.
mkdir -p "$HOME/repos/sample"
git -C "$HOME/repos/sample" init -q -b main
printf 'sample\n' >"$HOME/repos/sample/README.md"
git -C "$HOME/repos/sample" add README.md
git -C "$HOME/repos/sample" -c user.name="Wisp Update Test" -c user.email=update-test@example.invalid \
  commit -qm "sample"
wisp project add "$HOME/repos/sample" >"$HOME/project.log" 2>&1 ||
  { cat "$HOME/project.log" >&2; fail "the $PREVIOUS CLI could not register a project"; }
TOKEN_BEFORE="$(wisp token)"
wisp project ls >"$HOME/projects-before.txt"
grep -q "$HOME/repos/sample" "$HOME/projects-before.txt" || fail "the $PREVIOUS daemon did not list the project"

# 4. The previous release's own update command, against its own daemon.
"$INSTALL_ROOT/versions/$PREVIOUS/wisp" update --yes >"$HOME/update.log" 2>&1 ||
  { cat "$HOME/update.log" >&2; fail "the $PREVIOUS 'wisp update --yes' failed"; }
cat "$HOME/update.log"
grep -q "to $CANDIDATE" "$HOME/update.log" || fail "the $PREVIOUS CLI did not start an update to $CANDIDATE"

# 5. Supervisor restarts the swapped daemon; the candidate must come back.
UPDATED=no
for _ in $(seq 1 600); do
  if [ "$(health_field version 2>/dev/null)" = "$CANDIDATE" ]; then
    UPDATED=yes
    break
  fi
  sleep 0.2
done
[ "$UPDATED" = yes ] || fail "the daemon did not come back as $CANDIDATE"
wait_running || fail "Supervisor did not report the $CANDIDATE daemon RUNNING"
NEW_PID="$(supervisorctl pid wisp)"
[ "$NEW_PID" != "$OLD_PID" ] || fail "Supervisor still reports the $PREVIOUS daemon's PID"
[ "$(health_field commit)" = "$CANDIDATE_COMMIT" ] || fail "the daemon's commit is not the candidate's"
[ "$(health_field dirty)" = "False" ] || fail "the updated daemon reports a dirty build"
[ "$(readlink "$INSTALL_ROOT/current")" = "$INSTALL_ROOT/versions/$CANDIDATE/wisp" ] ||
  fail "current does not point at the $CANDIDATE binary"
test -x "$INSTALL_ROOT/versions/$PREVIOUS/wisp" || fail "the $PREVIOUS binary was not kept"
wisp version --json | grep -q "\"version\":\"$CANDIDATE\"" || fail "the wisp command is not $CANDIDATE"

# The previous release's state, read by the candidate.
[ "$(wisp token)" = "$TOKEN_BEFORE" ] || fail "the daemon token changed across the update"
wisp project ls >"$HOME/projects-after.txt"
grep -q "$HOME/repos/sample" "$HOME/projects-after.txt" || fail "the project registered by $PREVIOUS is gone"

# The candidate reads the same channel and agrees it is current.
wisp update >"$HOME/update-after.log" 2>&1 ||
  { cat "$HOME/update-after.log" >&2; fail "the $CANDIDATE 'wisp update' check failed"; }
grep -q "Wisp $CANDIDATE is up to date" "$HOME/update-after.log" ||
  { cat "$HOME/update-after.log" >&2; fail "the $CANDIDATE daemon does not consider itself current"; }

if grep -niE "error|fatal|panic|uncaught|unhandled" "$DAEMON_LOG" >"$HOME/daemon-errors.txt"; then
  cat "$HOME/daemon-errors.txt" >&2
  fail "the daemon log reports errors across the update"
fi
echo "--- daemon log"
cat "$DAEMON_LOG"
echo "previous release $PREVIOUS updated itself to $CANDIDATE under Supervisor; its state survived"
