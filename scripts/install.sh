#!/bin/sh
set -eu

VERSION="${WISP_VERSION:-0.4.0-alpha.6}"
INSTALL_ROOT="${WISP_INSTALL_ROOT:-$HOME/.local/share/wisp}"
BIN_DIR="${WISP_BIN_DIR:-$HOME/.local/bin}"
WISP_HOME="${WISP_HOME:-$HOME/.wisp}"
RELEASE_BASE_URL="${WISP_RELEASE_BASE_URL:-https://github.com/Pepewitch/wisp/releases/download/v$VERSION}"
EXPECTED_SHA256="${WISP_SHA256:-}"
EXPECTED_COMMIT="${WISP_COMMIT:-}"
LOCAL_ARTIFACT="${WISP_ARTIFACT_PATH:-}"
SERVICE_MODE="${WISP_INSTALL_SERVICE:-auto}"
ARTIFACT="wisp-v${VERSION}-linux-x86_64"
MARKER="wisp-managed-install-v1"

fail() {
  echo "wisp install: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: install.sh [--no-service]

Environment:
  WISP_VERSION             release version (default: 0.4.0-alpha.6)
  WISP_SHA256              pinned artifact checksum; otherwise fetch SHA256SUMS
  WISP_COMMIT              optional expected full build commit
  WISP_RELEASE_BASE_URL    release directory URL
  WISP_INSTALL_ROOT        managed version directory
  WISP_BIN_DIR             directory for the wisp symlink
  WISP_HOME                Wisp data/config directory
  WISP_ARTIFACT_PATH       verified local/offline artifact source
  WISP_INSTALL_SERVICE     auto or no
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-service) SERVICE_MODE="no" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = "Linux" ] || fail "supported platform is Linux x86_64; got $(uname -s) $(uname -m)"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "supported architecture is x86_64; got $(uname -m)" ;;
esac
case "$SERVICE_MODE" in
  auto|no) ;;
  *) fail "WISP_INSTALL_SERVICE must be 'auto' or 'no'" ;;
esac
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v install >/dev/null 2>&1 || fail "install is required"
case "$INSTALL_ROOT" in
  ""|"/"|"$HOME") fail "unsafe install root: $INSTALL_ROOT" ;;
esac
case "$BIN_DIR" in
  ""|"/") fail "unsafe binary directory: $BIN_DIR" ;;
esac
case "$WISP_HOME" in
  ""|"/") fail "unsafe WISP_HOME: $WISP_HOME" ;;
esac

TMP="$(mktemp -d)"
CANDIDATE=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$CANDIDATE" ] || rm -f "$CANDIDATE"
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM

DOWNLOADED="$TMP/$ARTIFACT"
if [ -n "$LOCAL_ARTIFACT" ]; then
  [ -f "$LOCAL_ARTIFACT" ] || fail "local artifact not found: $LOCAL_ARTIFACT"
  cp "$LOCAL_ARTIFACT" "$DOWNLOADED"
else
  command -v curl >/dev/null 2>&1 || fail "curl is required for release downloads"
  curl --fail --silent --show-error --location "$RELEASE_BASE_URL/$ARTIFACT" --output "$DOWNLOADED"
fi

if [ -z "$EXPECTED_SHA256" ]; then
  [ -z "$LOCAL_ARTIFACT" ] || fail "WISP_SHA256 is required with WISP_ARTIFACT_PATH"
  curl --fail --silent --show-error --location "$RELEASE_BASE_URL/SHA256SUMS" --output "$TMP/SHA256SUMS"
  EXPECTED_SHA256="$(awk -v file="$ARTIFACT" '$2 == file { print $1 }' "$TMP/SHA256SUMS")"
fi
case "$EXPECTED_SHA256" in
  ""|*[!0-9a-f]*) fail "no valid lowercase SHA-256 checksum found for $ARTIFACT" ;;
esac
[ "${#EXPECTED_SHA256}" -eq 64 ] || fail "SHA-256 checksum must have 64 lowercase hexadecimal characters"
printf '%s  %s\n' "$EXPECTED_SHA256" "$DOWNLOADED" | sha256sum --check --status ||
  fail "checksum mismatch for $ARTIFACT"

if [ -e "$INSTALL_ROOT" ]; then
  [ -d "$INSTALL_ROOT" ] || fail "install root is not a directory: $INSTALL_ROOT"
  [ -f "$INSTALL_ROOT/.managed-by-wisp" ] ||
    fail "refusing to use existing install root without Wisp marker: $INSTALL_ROOT"
  [ "$(cat "$INSTALL_ROOT/.managed-by-wisp")" = "$MARKER" ] ||
    fail "refusing to use install root with an unknown marker: $INSTALL_ROOT"
else
  mkdir -p "$INSTALL_ROOT"
  printf '%s\n' "$MARKER" > "$INSTALL_ROOT/.managed-by-wisp"
  chmod 0600 "$INSTALL_ROOT/.managed-by-wisp"
fi
chmod 0700 "$INSTALL_ROOT"

LINK="$BIN_DIR/wisp"
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  [ -L "$LINK" ] || fail "refusing to replace non-symlink command: $LINK"
  [ "$(readlink "$LINK")" = "$INSTALL_ROOT/current" ] ||
    fail "refusing to replace symlink not managed by Wisp: $LINK"
fi

mkdir -p "$INSTALL_ROOT/versions/$VERSION" "$BIN_DIR" "$WISP_HOME"
chmod 0700 "$WISP_HOME"
CANDIDATE="$INSTALL_ROOT/versions/$VERSION/.wisp.installing.$$"
install -m 0755 "$DOWNLOADED" "$CANDIDATE"

IDENTITY="$("$CANDIDATE" version --json)" || fail "downloaded artifact could not report its identity"
case "$IDENTITY" in
  *"\"version\":\"$VERSION\""*"\"dirty\":false"*) ;;
  *) fail "artifact identity does not match version $VERSION or reports a dirty build: $IDENTITY" ;;
esac
if [ -n "$EXPECTED_COMMIT" ]; then
  case "$IDENTITY" in
    *"\"commit\":\"$EXPECTED_COMMIT\""*) ;;
    *) fail "artifact commit does not match WISP_COMMIT: $IDENTITY" ;;
  esac
fi

WISP_HOME="$WISP_HOME" "$CANDIDATE" init >/dev/null
mv -f "$CANDIDATE" "$INSTALL_ROOT/versions/$VERSION/wisp"
CANDIDATE=""
ln -sfn "$INSTALL_ROOT/versions/$VERSION/wisp" "$INSTALL_ROOT/.current.new"
mv -f "$INSTALL_ROOT/.current.new" "$INSTALL_ROOT/current"

ln -sfn "$INSTALL_ROOT/current" "$LINK"

SERVICE_STARTED="no"
if [ "$SERVICE_MODE" = "auto" ] && [ "$BIN_DIR" = "$HOME/.local/bin" ] &&
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/wisp.service"
  if [ -e "$SERVICE_FILE" ] && ! grep -q '^# Managed by Wisp installer$' "$SERVICE_FILE"; then
    fail "refusing to replace unmanaged systemd unit: $SERVICE_FILE"
  fi
  mkdir -p "$SERVICE_DIR"
  cat > "$TMP/wisp.service" <<'EOF'
# Managed by Wisp installer
[Unit]
Description=Wisp coding-agent task manager
After=network.target

[Service]
Type=simple
ExecStart=%h/.local/bin/wisp serve
Restart=always
RestartSec=2
KillMode=process
UMask=0077

[Install]
WantedBy=default.target
EOF
  install -m 0644 "$TMP/wisp.service" "$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable --now wisp.service
  SERVICE_STARTED="yes"
fi

echo "installed Wisp $VERSION to $INSTALL_ROOT/versions/$VERSION/wisp"
echo "command: $LINK"
echo "data: $WISP_HOME (preserved by uninstall)"
if [ "$SERVICE_STARTED" = "yes" ]; then
  echo "service: systemd user unit enabled and started"
else
  echo "service: not started; run '$LINK serve' under your supervisor or in a foreground terminal"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "PATH: add $BIN_DIR to PATH before invoking 'wisp'" ;;
esac
echo "next: $LINK project add /path/to/repo && $LINK doctor"
