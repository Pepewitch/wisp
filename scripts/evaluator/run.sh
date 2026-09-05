#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVALUATOR_DIR="$ROOT/scripts/evaluator"
VERSION="0.4.0-alpha.7"
BASE_IMAGE="ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517"
IMAGE="${WISP_EVALUATOR_IMAGE:-wisp-evaluator:v0.4}"
ARTIFACT="${WISP_ARTIFACT_PATH:-$ROOT/dist/release/v$VERSION/wisp-v$VERSION-linux-x86_64}"
RELEASE_DIR="$(dirname "$ARTIFACT")"
OUTPUT_ROOT="${WISP_EVALUATOR_OUTPUT:-$ROOT/dist/evaluator}"
KEY_FILE=""
MODE=""
MODEL=""
TIMEOUT_SECONDS="${WISP_EVALUATOR_TIMEOUT_SECONDS:-1200}"
REBUILD_IMAGE=0
MODELS=(gpt-5.6-luna glm-5.2-fast grok-4.6)
INNER_MODEL="glm-5.2-fast"
PLACEHOLDER_KEY="fk-evaluator-placeholder-never-valid-000000000000"

usage() {
  cat <<'EOF'
usage:
  scripts/evaluator/run.sh --preflight [--rebuild-image]
  scripts/evaluator/run.sh --model <id> --droid-api-key-file <path> [--rebuild-image]
  scripts/evaluator/run.sh --all --droid-api-key-file <path> [--rebuild-image]

Options:
  --output <directory>       evidence root (default: dist/evaluator)
  --timeout <seconds>        model timeout per case (default: 1200)
  --rebuild-image            rebuild the pinned evaluator image

The API key file is mounted only into the authenticated egress proxy sidecars.
It is never mounted into the model container, copied into an image, or passed
as a process argument.
EOF
}

fail() {
  echo "evaluator: $*" >&2
  exit 1
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --preflight) MODE="preflight" ;;
    --all) MODE="all" ;;
    --model)
      [[ "$#" -ge 2 ]] || fail "--model requires an id"
      MODE="model"
      MODEL="$2"
      shift
      ;;
    --droid-api-key-file)
      [[ "$#" -ge 2 ]] || fail "--droid-api-key-file requires a path"
      KEY_FILE="$2"
      shift
      ;;
    --output)
      [[ "$#" -ge 2 ]] || fail "--output requires a directory"
      OUTPUT_ROOT="$2"
      shift
      ;;
    --timeout)
      [[ "$#" -ge 2 ]] || fail "--timeout requires seconds"
      TIMEOUT_SECONDS="$2"
      shift
      ;;
    --rebuild-image) REBUILD_IMAGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

[[ -n "$MODE" ]] || { usage >&2; exit 2; }
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "--timeout must be a positive integer"
[[ "$PLACEHOLDER_KEY" = fk-* && "${#PLACEHOLDER_KEY}" -ge 32 ]] ||
  fail "evaluator placeholder key is malformed"
[[ -f "$ARTIFACT" ]] || fail "missing artifact $ARTIFACT; run 'bun run release:linux' from a clean tree"
for file in release-manifest.json SHA256SUMS; do
  [[ -f "$RELEASE_DIR/$file" ]] || fail "missing $RELEASE_DIR/$file"
done

HEAD="$(git -C "$ROOT" rev-parse HEAD)"
[[ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=normal)" ]] ||
  fail "release qualification requires a clean worktree"
MANIFEST_COMMIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$RELEASE_DIR/release-manifest.json")"
[[ "$MANIFEST_COMMIT" = "$HEAD" ]] ||
  fail "artifact commit $MANIFEST_COMMIT does not match HEAD $HEAD; rebuild the release"
ARTIFACT_SHA256="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
MANIFEST_SHA256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"]["sha256"])' "$RELEASE_DIR/release-manifest.json")"
[[ "$ARTIFACT_SHA256" = "$MANIFEST_SHA256" ]] || fail "artifact checksum does not match release-manifest.json"
(cd "$RELEASE_DIR" && shasum -a 256 -c SHA256SUMS >/dev/null) || fail "SHA256SUMS verification failed"

if [[ "$MODE" != "preflight" ]]; then
  [[ -f "$KEY_FILE" ]] || fail "--droid-api-key-file must name a readable regular file"
  [[ ! -L "$KEY_FILE" ]] || fail "API key path must not be a symlink"
  KEY_FILE="$(cd "$(dirname "$KEY_FILE")" && pwd)/$(basename "$KEY_FILE")"
  KEY_MODE="$(stat -f '%Lp' "$KEY_FILE" 2>/dev/null || stat -c '%a' "$KEY_FILE")"
  [[ "$KEY_MODE" = "600" ]] || fail "API key file mode must be 600, got $KEY_MODE"
fi

if [[ "$REBUILD_IMAGE" -eq 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker buildx build \
    --load \
    --platform linux/amd64 \
    --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --tag "$IMAGE" \
    "$EVALUATOR_DIR"
fi
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$OUTPUT_ROOT/$RUN_ID"
mkdir -p "$RUN_DIR"
chmod 0700 "$RUN_DIR"

ENTRYPOINT_FILE="$RUN_DIR/ENTRYPOINT.md"
cat > "$ENTRYPOINT_FILE" <<EOF
# Wisp $VERSION staged Linux candidate

Supported target: Ubuntu 24.04 LTS, x86_64, glibc.

This candidate is staged locally because the publication gate is still held.
Install it with the release installer and these pinned facts:

\`\`\`sh
WISP_ARTIFACT_PATH=/release/wisp-v$VERSION-linux-x86_64 \\
WISP_SHA256=$ARTIFACT_SHA256 \\
WISP_COMMIT=$HEAD \\
WISP_INSTALL_SERVICE=no \\
sh /release/install.sh
\`\`\`

Then follow the normal activation contract: initialize Wisp, start or supervise
the daemon, register the supplied Git repository, and run
\`wisp doctor --harness droid\` before creating a task.

The web UI is served by the daemon. Run \`wisp token\` on this host when its
visible authentication dialog asks for the token.
EOF

cleanup_names=()
cleanup_paths=()
cleanup_volumes=()
cleanup() {
  local name path volume
  for name in "${cleanup_names[@]:-}"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  for name in "${cleanup_names[@]:-}"; do
    docker network rm "$name" >/dev/null 2>&1 || true
  done
  for volume in "${cleanup_volumes[@]:-}"; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
  for path in "${cleanup_paths[@]:-}"; do
    [[ -z "$path" ]] || rm -rf "$path"
  done
}
trap cleanup EXIT HUP INT TERM

start_proxy() {
  local name="$1"
  local outer_net="$2"
  local inner_net="$3"
  local alias="$4"
  local state="$5"
  local key="$6"
  local evidence="$7"
  local role="$8"

  docker run -d \
    --name "$name" \
    --network "$outer_net" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --pids-limit=256 \
    --memory=512m \
    --cpus=0.5 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev \
    --mount "type=bind,source=$key,target=/run/secrets/factory_api_key,readonly" \
    --mount "type=bind,source=$state,target=/proxy-state" \
    --mount "type=bind,source=$evidence,target=/evidence" \
    --env "WISP_EVALUATOR_PROXY_ROLE=$role" \
    --entrypoint /usr/bin/tini \
    "$IMAGE" -- \
    /opt/mitmproxy/bin/mitmdump \
      --listen-host 0.0.0.0 \
      --listen-port 8080 \
      --set confdir=/proxy-state \
      --set flow_detail=0 \
      --set console_eventlog_verbosity=warn \
      --scripts /opt/evaluator/auth-proxy.py \
    >/dev/null
  cleanup_names+=("$name")
  docker network connect --alias "$alias" "$inner_net" "$name"
  for _ in {1..100}; do
    [[ -s "$state/mitmproxy-ca-cert.pem" ]] && break
    sleep 0.1
  done
  [[ -s "$state/mitmproxy-ca-cert.pem" ]] || {
    docker logs "$name" >&2 || true
    fail "$role egress proxy did not produce its CA"
  }
  for _ in {1..100}; do
    docker exec "$name" python3 -c \
      'import socket; socket.create_connection(("127.0.0.1", 8080), 0.2).close()' \
      >/dev/null 2>&1 && break
    sleep 0.1
  done
  docker exec "$name" python3 -c \
    'import socket; socket.create_connection(("127.0.0.1", 8080), 0.2).close()' \
    >/dev/null 2>&1 || {
    docker logs "$name" >&2 || true
    fail "$role egress proxy did not start listening"
  }
}

run_case() {
  local case_name="$1"
  local case_mode="$2"
  local effort="$3"
  local case_dir="$RUN_DIR/$case_name"
  local nonce="${RUN_ID//[^A-Za-z0-9]/}-${case_name//[^A-Za-z0-9]/}"
  local inner_net="wisp-eval-inner-$nonce"
  local outer_net="wisp-eval-egress-$nonce"
  local proxy="wisp-eval-proxy-$nonce"
  local inner_proxy="wisp-eval-inner-proxy-$nonce"
  local inner_worker="wisp-eval-inner-worker-$nonce"
  local inner_rpc_volume="wisp-eval-inner-rpc-$nonce"
  local worktree_volume="wisp-eval-worktrees-$nonce"
  local repo_git_volume="wisp-eval-repo-git-$nonce"
  local runner="wisp-eval-case-$nonce"
  local proxy_state
  local inner_proxy_state
  local proxy_key
  local inner_droid="/opt/inner/fake-droid.py"
  local case_inner_model="$INNER_MODEL"
  local worker_network_env=()
  local worker_ca_mount=()

  mkdir -p "$case_dir"
  chmod 0700 "$case_dir"
  docker network create --internal "$inner_net" >/dev/null
  cleanup_names+=("$inner_net")

  proxy_state="$(mktemp -d)"
  cleanup_paths+=("$proxy_state")
  chmod 0700 "$proxy_state"
  docker volume create "$inner_rpc_volume" >/dev/null
  docker volume create "$worktree_volume" >/dev/null
  docker volume create "$repo_git_volume" >/dev/null
  cleanup_volumes+=("$inner_rpc_volume" "$worktree_volume" "$repo_git_volume")
  docker run --rm \
    --platform linux/amd64 \
    --cap-drop=ALL \
    --cap-add=CHOWN \
    --security-opt=no-new-privileges \
    --mount "type=volume,source=$inner_rpc_volume,target=/run/inner-rpc" \
    --mount "type=volume,source=$worktree_volume,target=/worktrees" \
    --mount "type=volume,source=$repo_git_volume,target=/repo-git" \
    --entrypoint /bin/chown \
    "$IMAGE" 10001:10001 /run/inner-rpc /worktrees /repo-git

  if [[ "$case_mode" = "preflight" ]]; then
    case_inner_model="fake-model"
    proxy_key="$proxy_state/dummy-key"
    printf '%s\n' 'preflight-no-network-key' > "$proxy_key"
    chmod 0600 "$proxy_key"
  else
    proxy_key="$KEY_FILE"
    docker network create "$outer_net" >/dev/null
    cleanup_names+=("$outer_net")
    inner_proxy_state="$(mktemp -d)"
    cleanup_paths+=("$inner_proxy_state")
    chmod 0700 "$inner_proxy_state"
    start_proxy "$proxy" "$outer_net" "$inner_net" egress \
      "$proxy_state" "$proxy_key" "$case_dir" outer
    start_proxy "$inner_proxy" "$outer_net" "$inner_net" inner-egress \
      "$inner_proxy_state" "$proxy_key" "$case_dir" inner
    inner_droid="/opt/inner/node_modules/.bin/droid"
    worker_network_env=(
      --env HTTP_PROXY=http://inner-egress:8080
      --env HTTPS_PROXY=http://inner-egress:8080
      --env ALL_PROXY=http://inner-egress:8080
      --env NO_PROXY=127.0.0.1,localhost
      --env NODE_EXTRA_CA_CERTS=/proxy-ca/mitmproxy-ca-cert.pem
    )
    worker_ca_mount=(
      --mount "type=bind,source=$inner_proxy_state/mitmproxy-ca-cert.pem,target=/proxy-ca/mitmproxy-ca-cert.pem,readonly"
    )
  fi

  docker run -d \
    --name "$inner_worker" \
    --platform linux/amd64 \
    --network "$inner_net" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --pids-limit=384 \
    --memory=2g \
    --cpus=1.5 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev \
    --tmpfs /home/inner:rw,exec,nosuid,nodev,mode=0700,uid=10001,gid=10001 \
    --tmpfs /home/evaluator:rw,exec,nosuid,nodev,mode=0700,uid=10001,gid=10001 \
    --tmpfs /opt/evaluator:rw,noexec,nosuid,nodev,size=64k \
    --mount "type=volume,source=$inner_rpc_volume,target=/run/inner-rpc" \
    --mount "type=volume,source=$worktree_volume,target=/worktrees" \
    --mount "type=volume,source=$repo_git_volume,target=/repo-git" \
    ${worker_ca_mount[@]+"${worker_ca_mount[@]}"} \
    --user 10001:10001 \
    --env HOME=/home/inner \
    --env FACTORY_HOME_OVERRIDE=/home/inner \
    --env "FACTORY_API_KEY=$PLACEHOLDER_KEY" \
    --env FACTORY_DISABLE_KEYRING=true \
    --env DISABLE_AUTO_UPDATE=1 \
    --env FACTORY_DROID_AUTO_UPDATE_ENABLED=false \
    --env "WISP_EVALUATOR_INNER_DROID=$inner_droid" \
    --env "WISP_EVALUATOR_INNER_MODEL=$case_inner_model" \
    ${worker_network_env[@]+"${worker_network_env[@]}"} \
    --entrypoint /usr/bin/tini \
    "$IMAGE" -- /opt/inner/inner-worker.py \
    >/dev/null
  cleanup_names+=("$inner_worker")
  for _ in {1..100}; do
    docker exec "$inner_worker" test -S /run/inner-rpc/droid.sock \
      >/dev/null 2>&1 && break
    sleep 0.1
  done
  docker exec "$inner_worker" test -S /run/inner-rpc/droid.sock \
    >/dev/null 2>&1 || {
    docker logs "$inner_worker" >&2 || true
    fail "inner Droid worker did not start listening"
  }
  if [[ "$case_mode" != "preflight" ]]; then
    docker exec "$inner_worker" \
      /opt/inner/node_modules/.bin/droid doctor --auth --json --timeout 5000 \
      > "$case_dir/inner-droid-auth.json" \
      2> "$case_dir/inner-droid-auth.stderr" || {
      docker logs "$inner_worker" >&2 || true
      fail "inner Droid authentication preflight failed"
    }
  fi

  local network_env=()
  local ca_mount=()
  if [[ "$case_mode" != "preflight" ]]; then
    network_env=(
      --env HTTP_PROXY=http://egress:8080
      --env HTTPS_PROXY=http://egress:8080
      --env ALL_PROXY=http://egress:8080
      --env NO_PROXY=127.0.0.1,localhost
      --env NODE_EXTRA_CA_CERTS=/proxy-ca/mitmproxy-ca-cert.pem
    )
    ca_mount=(
      --mount "type=bind,source=$proxy_state/mitmproxy-ca-cert.pem,target=/proxy-ca/mitmproxy-ca-cert.pem,readonly"
    )
  fi

  set +e
  cleanup_names+=("$runner")
  docker run \
    --name "$runner" \
    --platform linux/amd64 \
    --network "$inner_net" \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --pids-limit=768 \
    --memory=3g \
    --cpus=2 \
    --shm-size=512m \
    --tmpfs /tmp:rw,noexec,nosuid,nodev \
    --tmpfs /run:rw,noexec,nosuid,nodev \
    --tmpfs /home/evaluator:rw,exec,nosuid,nodev,mode=0700,uid=10001,gid=10001 \
    --tmpfs /workspace:rw,exec,nosuid,nodev,mode=0700,uid=10001,gid=10001 \
    --mount "type=volume,source=$inner_rpc_volume,target=/run/inner-rpc" \
    --mount "type=volume,source=$worktree_volume,target=/worktrees" \
    --mount "type=volume,source=$repo_git_volume,target=/repo-git" \
    --mount "type=bind,source=$ARTIFACT,target=/release/wisp-v$VERSION-linux-x86_64,readonly" \
    --mount "type=bind,source=$ROOT/scripts/install.sh,target=/release/install.sh,readonly" \
    --mount "type=bind,source=$ROOT/scripts/uninstall.sh,target=/release/uninstall.sh,readonly" \
    --mount "type=bind,source=$RELEASE_DIR/release-manifest.json,target=/release/release-manifest.json,readonly" \
    --mount "type=bind,source=$RELEASE_DIR/SHA256SUMS,target=/release/SHA256SUMS,readonly" \
    --mount "type=bind,source=$ENTRYPOINT_FILE,target=/release/ENTRYPOINT.md,readonly" \
    --mount "type=bind,source=$case_dir,target=/evidence" \
    ${ca_mount[@]+"${ca_mount[@]}"} \
    --user 10001:10001 \
    --env HOME=/home/evaluator \
    --env "FACTORY_API_KEY=$PLACEHOLDER_KEY" \
    --env FACTORY_DISABLE_KEYRING=true \
    --env DISABLE_AUTO_UPDATE=1 \
    --env FACTORY_DROID_AUTO_UPDATE_ENABLED=false \
    --env "WISP_EVALUATOR_MODE=$case_mode" \
    --env "WISP_EVALUATOR_MODEL=$case_name" \
    --env "WISP_EVALUATOR_EFFORT=$effort" \
    --env "WISP_EVALUATOR_INNER_MODEL=$case_inner_model" \
    --env "WISP_EVALUATOR_TIMEOUT_SECONDS=$TIMEOUT_SECONDS" \
    --env "WISP_EVALUATOR_VERSION=$VERSION" \
    --env "WISP_EVALUATOR_ARTIFACT_SHA256=$ARTIFACT_SHA256" \
    --env "WISP_EVALUATOR_COMMIT=$HEAD" \
    --env "WISP_EVALUATOR_BASE_IMAGE=$BASE_IMAGE" \
    --env "WISP_EVALUATOR_IMAGE_ID=$IMAGE_ID" \
    --env WISP_EVALUATOR_DROID_VERSION=0.205.0 \
    --env WISP_EVALUATOR_BROWSER_VERSION=0.35.0 \
    --env WISP_EVALUATOR_CHROME_VERSION=152.0.7977.75 \
    ${network_env[@]+"${network_env[@]}"} \
    "$IMAGE"
  local case_exit=$?
  set -e
  docker logs "$runner" > "$case_dir/container.log" 2>&1 || true
  docker rm "$runner" >/dev/null
  cleanup_names=("${cleanup_names[@]/$runner}")

  docker logs "$inner_worker" > "$case_dir/inner-worker.log" 2>&1 || true
  mkdir -p "$case_dir/inner-droid-logs"
  docker cp "$inner_worker:/home/inner/.factory/logs/." \
    "$case_dir/inner-droid-logs/" >/dev/null 2>&1 || true
  if [[ "$case_mode" != "preflight" ]]; then
    docker logs "$proxy" > "$case_dir/proxy.log" 2>&1 || true
    docker logs "$inner_proxy" > "$case_dir/inner-proxy.log" 2>&1 || true
    python3 "$EVALUATOR_DIR/scan-evidence.py" \
      --evidence "$case_dir" \
      --key-file "$KEY_FILE" \
      --placeholder "$PLACEHOLDER_KEY"
  else
    python3 "$EVALUATOR_DIR/scan-evidence.py" \
      --evidence "$case_dir" \
      --placeholder "$PLACEHOLDER_KEY"
  fi
  python3 "$EVALUATOR_DIR/validate-case.py" "$case_dir/case.json"
  printf '%s\n' "$case_exit" > "$case_dir/container-exit.txt"
  return "$case_exit"
}

overall=0
case "$MODE" in
  preflight)
    run_case preflight-fake preflight off || overall=1
    ;;
  model)
    case "$MODEL" in
      gpt-5.6-luna) effort=medium ;;
      glm-5.2-fast) effort=high ;;
      grok-4.6) effort=medium ;;
      *) fail "model must be one of: ${MODELS[*]}" ;;
    esac
    run_case "$MODEL" model "$effort" || overall=1
    ;;
  all)
    for candidate in "${MODELS[@]}"; do
      case "$candidate" in
        gpt-5.6-luna) effort=medium ;;
        glm-5.2-fast) effort=high ;;
        grok-4.6) effort=medium ;;
      esac
      run_case "$candidate" model "$effort" || overall=1
    done
    ;;
esac

python3 "$EVALUATOR_DIR/aggregate.py" "$RUN_DIR" || overall=1
echo "evaluator evidence: $RUN_DIR"
exit "$overall"
