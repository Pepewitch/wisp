#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${WISP_ACTIVATION_TEST_IMAGE:-ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517}"
ARTIFACT="${WISP_ARTIFACT_PATH:-$ROOT/dist/release/v0.4.0-alpha.6/wisp-v0.4.0-alpha.6-linux-x86_64}"

[[ -f "$ARTIFACT" ]] || {
  echo "activation test: missing artifact $ARTIFACT; run 'bun run release:linux' first" >&2
  exit 1
}
SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
CFG="$(mktemp -d)"
trap 'rm -rf "$CFG"' EXIT
printf '{"auths":{}}\n' > "$CFG/config.json"

docker --config "$CFG" run --rm --platform linux/amd64 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=256 --memory=768m --cpus=1 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --tmpfs /run:rw,noexec,nosuid,nodev \
  --tmpfs /home/evaluator:rw,exec,nosuid,nodev,mode=0700,uid=1000,gid=1000 \
  --tmpfs /workspace:rw,exec,nosuid,nodev,mode=0700,uid=1000,gid=1000 \
  --mount "type=bind,source=$ARTIFACT,target=/release/wisp,readonly" \
  --mount "type=bind,source=$ROOT/scripts/install.sh,target=/install.sh,readonly" \
  --user 1000:1000 \
  --env HOME=/home/evaluator \
  --env WISP_ARTIFACT_PATH=/release/wisp \
  --env WISP_SHA256="$SHA256" \
  --env WISP_COMMIT="$COMMIT" \
  --env WISP_INSTALL_SERVICE=no \
  "$IMAGE" /bin/sh -eu -c '
    mkdir -p "$HOME/fake-bin" /workspace/repo
    cat > "$HOME/fake-bin/droid" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo "droid 0.205.0"
  exit 0
fi
if [ "\${1:-}" = "doctor" ]; then
  echo "{\"ok\":true,\"results\":[]}"
  exit 0
fi
exit 1
EOF
    cat > "$HOME/fake-bin/git" <<EOF
#!/bin/sh
case " \$* " in
  *" --version "*) echo "git version 2.43.0" ;;
  *" rev-parse "*) echo "true" ;;
  *" user.name "*) echo "Wisp Evaluator" ;;
  *" user.email "*) echo "wisp-evaluator@example.invalid" ;;
  *) exit 1 ;;
esac
EOF
    cat > "$HOME/fake-bin/systemctl" <<EOF
#!/bin/sh
[ "\$*" = "--user is-enabled wisp.service" ] || exit 1
echo "enabled"
EOF
    chmod 0755 "$HOME/fake-bin/droid" "$HOME/fake-bin/git" "$HOME/fake-bin/systemctl"
    PATH="$HOME/fake-bin:$HOME/.local/bin:$PATH"
    export PATH

    /bin/sh /install.sh >"$HOME/install.log"
    wisp serve >"$HOME/daemon.log" 2>&1 &
    DAEMON_PID=$!
    trap "kill \$DAEMON_PID 2>/dev/null || true" EXIT HUP INT TERM

    REGISTERED=no
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if wisp project add /workspace/repo >"$HOME/project.log" 2>&1; then
        REGISTERED=yes
        break
      fi
      sleep 0.2
    done
    [ "$REGISTERED" = "yes" ] || {
      cat "$HOME/daemon.log" >&2
      cat "$HOME/project.log" >&2
      exit 1
    }

    wisp doctor --harness droid >"$HOME/doctor.log"
    grep -q "^ok   platform:" "$HOME/doctor.log"
    grep -q "^ok   project: /workspace/repo$" "$HOME/doctor.log"
    grep -q "^ok   harness droid auth:" "$HOME/doctor.log"
    grep -q "^ok   supervisor:" "$HOME/doctor.log"
    grep -q "^ok   daemon:" "$HOME/doctor.log"
    grep -q "^ok   activation: ready for a first task with droid" "$HOME/doctor.log"
    ! grep -q "^fail " "$HOME/doctor.log"
    cat "$HOME/doctor.log"
    echo "clean install through activation receipt passed"
  '
