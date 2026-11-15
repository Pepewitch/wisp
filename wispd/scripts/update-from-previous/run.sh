#!/usr/bin/env bash
# The update-from-previous gate: prove the previous published release can
# update itself to the candidate through its own, unmodified update path.
#
# `wisp update` always runs the OLD release's code, so a candidate that breaks
# the update contract (artifact name, manifest shape, size limits, channel
# schema, migrations on start) strands every user who has the old one. This
# installs the release the tap currently promotes, from its own GitHub assets
# and with its own installer, supervises it with Supervisor as docs/INSTALL.md
# documents, and runs its `wisp update --yes` against a local mirror that
# answers GitHub's names with the candidate (see mirror.py).
#
# Input: WISP_ARTIFACT_PATH, the candidate Linux artifact (default: this
# checkout's dist/release build), with the release-manifest.json that
# release-linux.ts wrote beside it.
# WISP_PREVIOUS_VERSION overrides the previous release (default: the version
# the tap's update channel promotes). Network access is needed only to read
# that channel, download the previous release, and build the image.
#
# When the candidate is not newer than the previous release (an ordinary pull
# request that does not bump the version), the gate builds a synthetic
# candidate from the same commit with only its version raised one patch above
# the previous release, so the update contract is still exercised on every
# change. Release-preparation commits test the real candidate artifact.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERE="$ROOT/wispd/scripts/update-from-previous"
BASE_IMAGE="${WISP_UPDATE_TEST_BASE_IMAGE:-ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517}"
CHANNEL_URL="https://raw.githubusercontent.com/Pepewitch/homebrew-tap/main/updates/wisp-daemon.json"
RELEASES="https://github.com/Pepewitch/wisp/releases/download"
ARTIFACT="${WISP_ARTIFACT_PATH:-}"
if [[ -z "$ARTIFACT" ]]; then
  version="$(cd "$ROOT" && bun -e 'import { VERSION } from "./wispd/src/version"; process.stdout.write(VERSION)')"
  ARTIFACT="$ROOT/dist/release/v$version/wisp-v$version-linux-x86_64"
fi

say() { echo "update-from-previous: $*"; }
die() {
  echo "update-from-previous: $*" >&2
  exit 1
}
[[ -f "$ARTIFACT" ]] || die "missing candidate artifact $ARTIFACT; run 'bun run release:linux' first"
ARTIFACT="$(cd "$(dirname "$ARTIFACT")" && pwd)/$(basename "$ARTIFACT")"

WORK="$(mktemp -d)"
NET="wisp-update-test-$$"
MIRROR="wisp-update-mirror-$$"
SYNTHETIC_TREE=""
cleanup() {
  docker rm -f "$MIRROR" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [[ -n "$SYNTHETIC_TREE" ]]; then git -C "$ROOT" worktree remove --force "$SYNTHETIC_TREE" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/docker"
printf '{"auths":{}}\n' >"$WORK/docker/config.json"
docker() { command docker --config "$WORK/docker" "$@"; }

# Print one field of a JSON file, or fail if it is missing or not a string.
json_field() {
  bun -e '
    const [file, ...path] = process.argv.slice(1);
    let value = JSON.parse(await Bun.file(file).text());
    for (const key of path) value = value?.[key];
    if (typeof value !== "string" && typeof value !== "number") throw new Error(`${file}: no ${path.join(".")}`);
    process.stdout.write(String(value));
  ' "$@"
}
compare_versions() {
  bun -e '
    import { compareVersions } from "./shared/release-version";
    process.stdout.write(String(Math.sign(compareVersions(process.argv[1], process.argv[2]))));
  ' "$1" "$2"
}
download() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --silent --show-error --location --retry 3 --output "$2" "$1"
}
sha256() { sha256sum "$1" | awk '{print $1}'; }

# The candidate, checked against the manifest the release build wrote.
read_candidate() {
  CANDIDATE_MANIFEST="$(dirname "$ARTIFACT")/release-manifest.json"
  [[ -f "$CANDIDATE_MANIFEST" ]] || die "no release-manifest.json beside $ARTIFACT"
  CANDIDATE="$(json_field "$CANDIDATE_MANIFEST" version)"
  CANDIDATE_COMMIT="$(json_field "$CANDIDATE_MANIFEST" commit)"
  [[ "$(json_field "$CANDIDATE_MANIFEST" artifact file)" = "wisp-v$CANDIDATE-linux-x86_64" ]] ||
    die "the candidate manifest names another artifact"
  [[ "$(json_field "$CANDIDATE_MANIFEST" artifact sha256)" = "$(sha256 "$ARTIFACT")" ]] ||
    die "the candidate artifact does not match its manifest"
}
read_candidate
cd "$ROOT"

if [[ -n "${WISP_PREVIOUS_VERSION:-}" ]]; then
  PREVIOUS="$WISP_PREVIOUS_VERSION"
else
  download "$CHANNEL_URL" "$WORK/promoted.json"
  PREVIOUS="$(json_field "$WORK/promoted.json" version)"
fi
[[ "$PREVIOUS" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid previous version: $PREVIOUS"

if [[ "$(compare_versions "$CANDIDATE" "$PREVIOUS")" != 1 ]]; then
  # Same commit, version raised past the previous release, built clean in a
  # throwaway worktree so the candidate keeps a clean, verifiable identity.
  IFS=. read -r major minor patch <<<"${PREVIOUS%%-*}"
  SYNTHETIC="$major.$minor.$((patch + 1))"
  say "candidate $CANDIDATE is not newer than the promoted $PREVIOUS;" \
    "testing a synthetic $SYNTHETIC built from $CANDIDATE_COMMIT (never published)"
  SYNTHETIC_TREE="$WORK/synthetic"
  git worktree add --quiet --detach "$SYNTHETIC_TREE" "$CANDIDATE_COMMIT"
  (
    cd "$SYNTHETIC_TREE"
    bun install --frozen-lockfile
    bun run version:set "$SYNTHETIC"
    git add -A
    git -c user.name="Wisp Update Test" -c user.email=update-test@example.invalid -c commit.gpgsign=false \
      commit --quiet --no-verify -m "test: synthetic $SYNTHETIC for the update-from-previous gate"
    bun run build:ui
    bun run release:linux
  ) >"$WORK/synthetic-build.log" 2>&1 || {
    cat "$WORK/synthetic-build.log" >&2
    die "could not build the synthetic $SYNTHETIC candidate"
  }
  ARTIFACT="$SYNTHETIC_TREE/dist/release/v$SYNTHETIC/wisp-v$SYNTHETIC-linux-x86_64"
  read_candidate
fi
say "previous $PREVIOUS -> candidate $CANDIDATE ($CANDIDATE_COMMIT)"

# The previous release, exactly as GitHub serves it, verified three ways:
# SHA256SUMS, its own manifest, and the tag it was built from.
PREV_DIR="$WORK/previous"
mkdir -p "$PREV_DIR"
PREV_ARTIFACT="wisp-v$PREVIOUS-linux-x86_64"
for asset in "$PREV_ARTIFACT" SHA256SUMS release-manifest.json; do
  download "$RELEASES/v$PREVIOUS/$asset" "$PREV_DIR/$asset"
done
listed_sha256() { awk -v file="$1" '$2 == file { print $1 }' "$PREV_DIR/SHA256SUMS"; }
PREVIOUS_SHA256="$(sha256 "$PREV_DIR/$PREV_ARTIFACT")"
[[ "$(listed_sha256 "$PREV_ARTIFACT")" = "$PREVIOUS_SHA256" &&
  "$(listed_sha256 release-manifest.json)" = "$(sha256 "$PREV_DIR/release-manifest.json")" ]] ||
  die "the $PREVIOUS assets do not match their SHA256SUMS"
[[ "$(json_field "$PREV_DIR/release-manifest.json" version)" = "$PREVIOUS" &&
  "$(json_field "$PREV_DIR/release-manifest.json" artifact sha256)" = "$PREVIOUS_SHA256" ]] ||
  die "the $PREVIOUS manifest does not describe its artifact"
PREVIOUS_COMMIT="$(json_field "$PREV_DIR/release-manifest.json" commit)"
# The installer contract can change between releases, so the previous release
# is installed by the script from its own tag.
if ! TAG_COMMIT="$(git rev-parse --verify --quiet "refs/tags/v$PREVIOUS^{commit}")"; then
  git fetch --quiet --no-tags origin "refs/tags/v$PREVIOUS"
  TAG_COMMIT="$(git rev-parse --verify "FETCH_HEAD^{commit}")"
fi
[[ "$TAG_COMMIT" = "$PREVIOUS_COMMIT" ]] ||
  die "tag v$PREVIOUS is $TAG_COMMIT but its release was built from $PREVIOUS_COMMIT"
git show "$TAG_COMMIT:scripts/install.sh" >"$PREV_DIR/install.sh"

# What the mirror serves: the channel the promotion would publish for this
# candidate, rendered by the promotion's own renderer, and the release files.
MIRROR_DIR="$WORK/mirror"
mkdir -p "$MIRROR_DIR"
bun -e '
  import { renderDaemonUpdateChannel } from "./scripts/render-daemon-update-channel";
  const manifest = JSON.parse(await Bun.file(process.argv[1]).text());
  const publishedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  await Bun.write(process.argv[2], renderDaemonUpdateChannel(manifest, publishedAt));
' "$CANDIDATE_MANIFEST" "$MIRROR_DIR/channel.json"

# A throwaway CA, valid for a day, and a server certificate for the three
# GitHub names. Neither key leaves this run.
CERTS="$WORK/certs"
mkdir -p "$CERTS"
cat >"$CERTS/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Wisp update-from-previous test CA
[ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:github.com, DNS:raw.githubusercontent.com, DNS:api.github.com
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
EOF
openssl ecparam -name prime256v1 -genkey -noout -out "$CERTS/ca.key" 2>/dev/null
openssl req -config "$CERTS/openssl.cnf" -new -x509 -days 1 -key "$CERTS/ca.key" \
  -extensions ca -out "$CERTS/ca.pem"
openssl ecparam -name prime256v1 -genkey -noout -out "$CERTS/server.key" 2>/dev/null
openssl req -config "$CERTS/openssl.cnf" -new -key "$CERTS/server.key" -subj "/CN=github.com" \
  -out "$CERTS/server.csr"
openssl x509 -req -days 1 -in "$CERTS/server.csr" -CA "$CERTS/ca.pem" -CAkey "$CERTS/ca.key" \
  -CAcreateserial -extfile "$CERTS/openssl.cnf" -extensions server -out "$CERTS/server.pem" 2>/dev/null
# The containers run as uid 1000, not as this user.
chmod 0755 "$WORK" "$PREV_DIR" "$MIRROR_DIR" "$CERTS"
chmod 0644 "$CERTS"/*.pem "$CERTS/server.key" "$MIRROR_DIR/channel.json" "$PREV_DIR/install.sh"
chmod 0755 "$PREV_DIR/$PREV_ARTIFACT"

IMAGE="wisp-update-test:$({ cat "$HERE/Dockerfile"; echo "$BASE_IMAGE"; } | sha256sum | cut -c1-16)"
docker build --quiet --platform linux/amd64 --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --tag "$IMAGE" - <"$HERE/Dockerfile" >/dev/null

# An internal network: the only reachable host is the mirror, under GitHub's
# names. A request for anything else fails rather than reaching the internet.
docker network create --internal "$NET" >/dev/null
docker run --detach --name "$MIRROR" --platform linux/amd64 \
  --network "$NET" \
  --network-alias github.com --network-alias raw.githubusercontent.com --network-alias api.github.com \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=256m \
  --sysctl net.ipv4.ip_unprivileged_port_start=443 \
  --user 1000:1000 \
  --mount "type=bind,source=$HERE/mirror.py,target=/mirror.py,readonly" \
  --mount "type=bind,source=$CERTS/server.pem,target=/certs/server.pem,readonly" \
  --mount "type=bind,source=$CERTS/server.key,target=/certs/server.key,readonly" \
  --mount "type=bind,source=$MIRROR_DIR/channel.json,target=/mirror/channel.json,readonly" \
  --mount "type=bind,source=$CANDIDATE_MANIFEST,target=/mirror/release-manifest.json,readonly" \
  --mount "type=bind,source=$ARTIFACT,target=/mirror/artifact,readonly" \
  "$IMAGE" python3 -I /mirror.py "$CANDIDATE" >/dev/null
for _ in $(seq 1 50); do
  docker logs "$MIRROR" 2>&1 | grep -q '"event": "listening"' && break
  sleep 0.2
done
docker logs "$MIRROR" 2>&1 | grep -q '"event": "listening"' || {
  docker logs "$MIRROR" >&2 || true
  die "the mirror did not start"
}

status=0
docker run --rm --platform linux/amd64 \
  --network "$NET" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=512 --memory=2g --cpus=2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --tmpfs /run:rw,noexec,nosuid,nodev \
  --tmpfs /home/wisp:rw,exec,nosuid,nodev,mode=0700,uid=1000,gid=1000 \
  --mount "type=bind,source=$PREV_DIR/$PREV_ARTIFACT,target=/release/previous,readonly" \
  --mount "type=bind,source=$PREV_DIR/install.sh,target=/install.sh,readonly" \
  --mount "type=bind,source=$CERTS/ca.pem,target=/certs/ca.pem,readonly" \
  --mount "type=bind,source=$HERE/container.sh,target=/container.sh,readonly" \
  --user 1000:1000 \
  --env HOME=/home/wisp \
  --env PREVIOUS="$PREVIOUS" \
  --env PREVIOUS_SHA256="$PREVIOUS_SHA256" \
  --env CANDIDATE="$CANDIDATE" \
  --env CANDIDATE_COMMIT="$CANDIDATE_COMMIT" \
  "$IMAGE" /bin/bash /container.sh || status=$?

docker logs "$MIRROR" >"$WORK/mirror.log" 2>&1 || true
echo "--- mirror requests"
cat "$WORK/mirror.log"
if grep -q '"event": "unexpected"' "$WORK/mirror.log"; then
  die "the update path made a request the mirror does not serve (see above)"
fi
[[ "$status" = 0 ]] || die "the update from $PREVIOUS to $CANDIDATE failed (exit $status)"
for path in "/v$CANDIDATE/release-manifest.json" "/v$CANDIDATE/wisp-v$CANDIDATE-linux-x86_64"; do
  grep -q "\"path\": \"/Pepewitch/wisp/releases/download$path\"" "$WORK/mirror.log" ||
    die "the update never downloaded $path from the mirror"
done
say "passed: $PREVIOUS updated itself to $CANDIDATE"
