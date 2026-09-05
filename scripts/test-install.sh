#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${WISP_INSTALL_TEST_IMAGE:-ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517}"
ARTIFACT="${WISP_ARTIFACT_PATH:-$ROOT/dist/release/v0.4.0-alpha.6/wisp-v0.4.0-alpha.6-linux-x86_64}"

[[ -f "$ARTIFACT" ]] || {
  echo "install test: missing artifact $ARTIFACT; run 'bun run release:linux' first" >&2
  exit 1
}
SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
CFG="$(mktemp -d)"
trap 'rm -rf "$CFG"' EXIT
printf '{"auths":{}}\n' > "$CFG/config.json"

docker --config "$CFG" run --rm --platform linux/amd64 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --tmpfs /run:rw,noexec,nosuid,nodev \
  --tmpfs /home/evaluator:rw,exec,nosuid,nodev,mode=0700,uid=1000,gid=1000 \
  --mount "type=bind,source=$ARTIFACT,target=/release/wisp,readonly" \
  --mount "type=bind,source=$ROOT/scripts/install.sh,target=/install.sh,readonly" \
  --mount "type=bind,source=$ROOT/scripts/uninstall.sh,target=/uninstall.sh,readonly" \
  --user 1000:1000 \
  --env HOME=/home/evaluator \
  --env WISP_ARTIFACT_PATH=/release/wisp \
  --env WISP_SHA256="$SHA256" \
  --env WISP_INSTALL_SERVICE=no \
  "$IMAGE" /bin/sh -eu -c '
    if WISP_SHA256=0000000000000000000000000000000000000000000000000000000000000000 \
      /bin/sh /install.sh >"$HOME/bad-checksum.log" 2>&1; then
      echo "installer accepted a bad checksum" >&2
      exit 1
    fi
    grep -q "checksum mismatch" "$HOME/bad-checksum.log"
    test ! -e "$HOME/.local/share/wisp"

    WISP_HOME="$HOME/occupied-home" /release/wisp init --port 8710 >/dev/null
    WISP_HOME="$HOME/occupied-home" /release/wisp serve >"$HOME/occupied.log" 2>&1 &
    OCCUPIED_PID=$!
    sleep 1
    kill -0 "$OCCUPIED_PID"

    /bin/sh /install.sh
    kill "$OCCUPIED_PID"
    wait "$OCCUPIED_PID" 2>/dev/null || true
    test "$(sed -n "s/.*\"port\": \\([0-9]*\\).*/\\1/p" "$HOME/.wisp/config.json")" = 8711
    FIRST_CONFIG="$(sha256sum "$HOME/.wisp/config.json")"
    test "$(stat -c %a "$HOME/.wisp")" = 700
    test "$(stat -c %a "$HOME/.wisp/config.json")" = 600
    "$HOME/.local/bin/wisp" version --json | grep -q "\"dirty\":false"

    /bin/sh /install.sh
    test "$FIRST_CONFIG" = "$(sha256sum "$HOME/.wisp/config.json")"
    test "$(find "$HOME/.local/share/wisp/versions" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 1

    printf "user data survives\n" > "$HOME/.wisp/preserve-me"
    /bin/sh /uninstall.sh
    test ! -e "$HOME/.local/bin/wisp"
    test ! -e "$HOME/.local/share/wisp"
    test -f "$HOME/.wisp/preserve-me"

    mkdir -p "$HOME/fake-bin"
    cat > "$HOME/fake-bin/systemctl" <<EOF
#!/bin/sh
printf "%s\\n" "\$*" >> "$HOME/systemctl.log"
exit 0
EOF
    chmod 0755 "$HOME/fake-bin/systemctl"
    PATH="$HOME/fake-bin:$PATH" WISP_INSTALL_SERVICE=auto /bin/sh /install.sh
    SERVICE="$HOME/.config/systemd/user/wisp.service"
    test -f "$SERVICE"
    grep -q "^# Managed by Wisp installer$" "$SERVICE"
    grep -q "^ExecStart=%h/.local/bin/wisp serve$" "$SERVICE"
    grep -q -- "--user enable --now wisp.service" "$HOME/systemctl.log"
    PATH="$HOME/fake-bin:$PATH" /bin/sh /uninstall.sh
    test ! -e "$SERVICE"
    grep -q -- "--user disable --now wisp.service" "$HOME/systemctl.log"

    mkdir -p "$HOME/.local/share/wisp"
    printf "do not delete\n" > "$HOME/.local/share/wisp/unmanaged"
    if /bin/sh /uninstall.sh >"$HOME/unmanaged.log" 2>&1; then
      echo "uninstaller accepted an unmarked directory" >&2
      exit 1
    fi
    test -f "$HOME/.local/share/wisp/unmanaged"
    grep -q "without Wisp marker" "$HOME/unmanaged.log"
    echo "install, idempotent reinstall, and safe removal passed"
  '
