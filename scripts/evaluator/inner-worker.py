#!/usr/bin/env python3
"""Run Wisp's inner Droid in a dedicated container and stream its output."""

from __future__ import annotations

import base64
import json
import os
import re
import signal
import socket
import socketserver
import subprocess
import threading
from pathlib import Path
from typing import Any

SOCKET_PATH = Path(os.environ.get("WISP_EVALUATOR_INNER_SOCKET", "/run/inner-rpc/droid.sock"))
EXPOSED_WORKTREE_ROOT = Path(
    os.environ.get("WISP_EVALUATOR_WORKTREE_ROOT", "/home/evaluator/.wisp/worktrees")
)
ACTUAL_WORKTREE_ROOT = Path(os.environ.get("WISP_EVALUATOR_WORKER_WORKTREE_ROOT", "/worktrees"))
INNER_DROID = os.environ.get(
    "WISP_EVALUATOR_INNER_DROID", "/opt/inner/node_modules/.bin/droid"
)
EXPECTED_MODEL = os.environ.get("WISP_EVALUATOR_INNER_MODEL", "glm-5.2-fast")
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_CHUNK = 64 * 1024
MAX_INPUT_CHUNK = 64 * 1024
TASK_ENV_NAMES = ("WISP_TASK_ID", "WISP_TASK_SLOT", "WISP_WORKTREE", "WISP_REPO")
TASK_ID_PATTERN = re.compile(r"t[abcdefghjkmnpqrstuvwxyz23456789]{5}")


def validate_argv(argv: object) -> list[str]:
    if not isinstance(argv, list) or any(not isinstance(value, str) for value in argv):
        raise ValueError("Droid arguments must be strings")
    required = ["exec", "-o", "stream-json", "--skip-permissions-unsafe"]
    if argv[: len(required)] != required:
        raise ValueError("inner worker accepts only Wisp's default Droid exec command")

    index = len(required)
    options: dict[str, str] = {}
    for option in ("-s", "-m", "-r"):
        if index < len(argv) - 1 and argv[index] == option:
            if index + 1 >= len(argv) - 1 or not argv[index + 1] or len(argv[index + 1]) > 200:
                raise ValueError(f"invalid {option} value")
            options[option] = argv[index + 1]
            index += 2
    if index != len(argv) - 1 or not argv[-1] or len(argv[-1]) > 1_000_000:
        raise ValueError("inner Droid command must end in exactly one prompt")
    if options.get("-m") != EXPECTED_MODEL:
        raise ValueError(f"inner Droid model must be {EXPECTED_MODEL}")
    return list(argv)


def map_worktree(name: object, root: Path = ACTUAL_WORKTREE_ROOT) -> Path:
    if not isinstance(name, str) or not name or name in {".", ".."}:
        raise ValueError("invalid worktree name")
    if Path(name).name != name:
        raise ValueError("worktree name must be one path component")
    worktree = (root / name).resolve(strict=True)
    if worktree.parent != root.resolve(strict=True):
        raise ValueError("worktree escapes the evaluator root")
    return worktree


def validate_request(payload: object) -> tuple[list[str], Path, dict[str, str]]:
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    argv = validate_argv(payload.get("argv"))
    if len(argv) > 128 or sum(len(value) for value in argv) > 1_000_000:
        raise ValueError("inner Droid arguments are too large")

    task_env = payload.get("taskEnv")
    if not isinstance(task_env, dict):
        raise ValueError("taskEnv must be an object")
    if set(task_env) - set(TASK_ENV_NAMES):
        raise ValueError("unexpected inner environment name")
    if any(not isinstance(value, str) for value in task_env.values()):
        raise ValueError("inner environment values must be strings")
    task_id = task_env.get("WISP_TASK_ID", "")
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise ValueError("invalid inner task id")
    if not task_env.get("WISP_TASK_SLOT", "").isdigit():
        raise ValueError("invalid inner task slot")
    if task_env.get("WISP_REPO") != "/workspace/repo":
        raise ValueError("inner task repository is outside the evaluator fixture")

    worktree = map_worktree(payload.get("worktree"))
    if not worktree.name.endswith(f"-{task_id}"):
        raise ValueError("inner worktree name does not match its task id")
    exposed = EXPOSED_WORKTREE_ROOT / worktree.name
    if task_env.get("WISP_WORKTREE") != str(exposed):
        raise ValueError("inner worktree environment does not match its task")
    return argv, worktree, dict(task_env)


def decode_stdin_frame(payload: object) -> bytes | None:
    if not isinstance(payload, dict):
        raise ValueError("inner stdin frame must be an object")
    if payload.get("type") == "stdin_end" and set(payload) == {"type"}:
        return None
    if set(payload) != {"stream", "data"} or payload.get("stream") != "stdin":
        raise ValueError("unknown inner stdin frame")
    encoded = payload.get("data")
    if not isinstance(encoded, str):
        raise ValueError("inner stdin data must be base64 text")
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError("inner stdin data is not valid base64") from error
    if len(data) > MAX_INPUT_CHUNK:
        raise ValueError("inner stdin chunk is too large")
    return data


def terminate(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


class InnerHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        send_lock = threading.Lock()
        disconnected = threading.Event()

        def send(payload: dict[str, Any]) -> None:
            if disconnected.is_set():
                return
            encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"
            try:
                with send_lock:
                    self.request.sendall(encoded)
            except OSError:
                disconnected.set()

        try:
            line = self.rfile.readline(MAX_FRAME_BYTES + 1)
            if not line or len(line) > MAX_FRAME_BYTES:
                raise ValueError("missing or oversized inner request")
            argv, worktree, task_env = validate_request(json.loads(line))
        except (ValueError, OSError, json.JSONDecodeError) as error:
            send({"type": "error", "message": str(error)})
            return

        child_env = {
            **os.environ,
            **task_env,
            "WISP_WORKTREE": str(worktree),
        }
        try:
            process = subprocess.Popen(
                [INNER_DROID, *argv],
                cwd=worktree,
                env=child_env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as error:
            send({"type": "error", "message": f"could not start inner Droid: {error}"})
            return

        def pump(stream: Any, name: str) -> None:
            try:
                while chunk := os.read(stream.fileno(), MAX_OUTPUT_CHUNK):
                    send(
                        {
                            "stream": name,
                            "data": base64.b64encode(chunk).decode("ascii"),
                        }
                    )
            except OSError:
                disconnected.set()

        def pump_input() -> None:
            try:
                while True:
                    line = self.rfile.readline(MAX_FRAME_BYTES + 1)
                    if not line:
                        disconnected.set()
                        return
                    if len(line) > MAX_FRAME_BYTES:
                        raise ValueError("inner stdin frame is too large")
                    data = decode_stdin_frame(json.loads(line))
                    if data is None:
                        process.stdin.close()
                        return
                    process.stdin.write(data)
                    process.stdin.flush()
            except (BrokenPipeError, OSError):
                return
            except (ValueError, json.JSONDecodeError) as error:
                send({"type": "error", "message": str(error)})
                disconnected.set()

        pumps = [
            threading.Thread(target=pump, args=(process.stdout, "stdout"), daemon=True),
            threading.Thread(target=pump, args=(process.stderr, "stderr"), daemon=True),
        ]
        for thread in pumps:
            thread.start()
        threading.Thread(target=pump_input, daemon=True).start()

        while process.poll() is None and not disconnected.wait(0.2):
            pass
        if disconnected.is_set():
            terminate(process)
        code = process.wait()
        for thread in pumps:
            thread.join(timeout=5)
        send({"type": "exit", "code": code})


class InnerServer(socketserver.UnixStreamServer):
    request_queue_size = 1


def prepare_state() -> None:
    home = Path.home()
    factory = home / ".factory"
    factory.mkdir(parents=True, mode=0o700, exist_ok=True)
    (factory / "settings.json").write_text(
        json.dumps(
            {
                "cloudSessionSync": False,
                "completionSound": "off",
                "awaitingInputSound": "off",
                "hooksDisabled": True,
                "enableDroidShield": True,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    os.chmod(factory / "settings.json", 0o600)

    mirror_parent = EXPOSED_WORKTREE_ROOT.parent
    mirror_parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not EXPOSED_WORKTREE_ROOT.exists():
        EXPOSED_WORKTREE_ROOT.symlink_to(ACTUAL_WORKTREE_ROOT, target_is_directory=True)

    SOCKET_PATH.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    SOCKET_PATH.unlink(missing_ok=True)


def main() -> int:
    prepare_state()
    with InnerServer(str(SOCKET_PATH), InnerHandler) as server:
        os.chmod(SOCKET_PATH, 0o600)
        server.serve_forever(poll_interval=0.2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
