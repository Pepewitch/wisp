#!/bin/sh
set -eu

INSTALL_ROOT="${WISP_INSTALL_ROOT:-$HOME/.local/share/wisp}"
BIN_DIR="${WISP_BIN_DIR:-$HOME/.local/bin}"
WISP_HOME="${WISP_HOME:-$HOME/.wisp}"
MARKER="wisp-managed-install-v1"

fail() {
  echo "wisp uninstall: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "usage: uninstall.sh"
      echo "removal always preserves WISP_HOME, repositories, branches, and worktrees"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

case "$INSTALL_ROOT" in
  ""|"/"|"$HOME") fail "unsafe install root: $INSTALL_ROOT" ;;
esac

SERVICE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/wisp.service"
if [ -e "$SERVICE_FILE" ] && grep -q '^# Managed by Wisp installer$' "$SERVICE_FILE"; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user disable --now wisp.service >/dev/null 2>&1 || true
  fi
  rm -f "$SERVICE_FILE"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
  fi
fi

LINK="$BIN_DIR/wisp"
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$INSTALL_ROOT/current" ]; then
  rm -f "$LINK"
elif [ -e "$LINK" ] || [ -L "$LINK" ]; then
  echo "left unmanaged command untouched: $LINK"
fi

if [ -e "$INSTALL_ROOT" ]; then
  [ -f "$INSTALL_ROOT/.managed-by-wisp" ] ||
    fail "refusing to remove install root without Wisp marker: $INSTALL_ROOT"
  [ "$(cat "$INSTALL_ROOT/.managed-by-wisp")" = "$MARKER" ] ||
    fail "refusing to remove install root with an unknown marker: $INSTALL_ROOT"
  rm -rf "$INSTALL_ROOT"
fi

echo "removed Wisp binaries; preserved data at $WISP_HOME"
