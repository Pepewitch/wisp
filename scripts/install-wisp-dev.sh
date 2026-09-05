#!/bin/sh
set -eu

ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
COMMON_DIR=$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [ -n "$COMMON_DIR" ] && [ "$(basename "$COMMON_DIR")" = ".git" ]; then
  STABLE_ROOT=$(dirname "$COMMON_DIR")
else
  STABLE_ROOT=$ROOT
fi
BIN_DIR=${WISP_DEV_BIN_DIR:-"$HOME/.local/bin"}
TARGET="$BIN_DIR/wisp-dev"
MARKER="# wisp-dev-launcher-v1"

fail() {
  printf 'install-wisp-dev: %s\n' "$*" >&2
  exit 1
}

case "$BIN_DIR" in
  ""|"/") fail "unsafe binary directory: $BIN_DIR" ;;
esac

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  grep -Fqx "$MARKER" "$TARGET" 2>/dev/null ||
    fail "refusing to replace unmanaged path: $TARGET"
fi

if [ ! -d "$BIN_DIR" ]; then
  mkdir -p "$BIN_DIR"
  chmod 0700 "$BIN_DIR"
fi
TMP=$(mktemp "$BIN_DIR/.wisp-dev.XXXXXX")
trap 'rm -f "$TMP"' EXIT HUP INT TERM

# Escape a single quote for a single-quoted POSIX shell literal.
quoted_root=$(printf '%s' "$ROOT" | sed "s/'/'\\\\''/g")
quoted_stable_root=$(printf '%s' "$STABLE_ROOT" | sed "s/'/'\\\\''/g")
{
  printf '%s\n' '#!/bin/sh' 'set -eu' "$MARKER"
  printf "fallback_root='%s'\n" "$quoted_root"
  printf "stable_root='%s'\n" "$quoted_stable_root"
  cat <<'EOF'

is_wisp_checkout() {
  [ -f "$1/package.json" ] &&
    [ -f "$1/src/index.ts" ] &&
    [ -f "$1/scripts/wisp-dev" ] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"wisp"' "$1/package.json"
}

root=${WISP_DEV_ROOT:-}
if [ -z "$root" ] && command -v git >/dev/null 2>&1; then
  candidate=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -n "$candidate" ] && is_wisp_checkout "$candidate"; then
    root=$candidate
  fi
fi
if [ -z "$root" ] && is_wisp_checkout "$stable_root"; then
  root=$stable_root
fi
root=${root:-$fallback_root}
is_wisp_checkout "$root" || {
  printf 'wisp-dev: source checkout not found at %s; rerun bun run dev:install-cli\n' "$root" >&2
  exit 1
}

exec sh "$root/scripts/wisp-dev" "$@"
EOF
} > "$TMP"

chmod 0755 "$TMP"
mv -f "$TMP" "$TARGET"
trap - EXIT HUP INT TERM

printf 'installed %s\n' "$TARGET"
printf 'production: wisp       (~/.wisp)\n'
printf 'development: wisp-dev  (~/.wisp-dev)\n'
