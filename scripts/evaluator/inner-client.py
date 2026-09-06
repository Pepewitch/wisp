#!/usr/bin/env python3
"""Forward one Wisp-launched Droid command to the isolated inner worker."""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import threading
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("WISP_EVALUATOR_INNER_SOCKET", "/run/inner-rpc/droid.sock"))
WORKTREE_ROOT = Path(
    os.environ.get("WISP_EVALUATOR_WORKTREE_ROOT", "/worktrees")
)
EXPOSED_WORKTREE_ROOT = Path("/home/evaluator/.wisp/worktrees")
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_INPUT_CHUNK = 64 * 1024


def request_payload(argv: list[str], cwd: Path, environ: dict[str, str]) -> dict[str, object]:
    if not argv or argv[0] != "exec":
        raise ValueError("inner worker accepts only Droid exec commands")

    root = WORKTREE_ROOT.resolve(strict=True)
    resolved = cwd.resolve(strict=True)
    relative = resolved.relative_to(root)
    if len(relative.parts) != 1:
        raise ValueError("inner Droid cwd must be one evaluator worktree")

    task_id = environ.get("WISP_TASK_ID", "")
    if not task_id:
        raise ValueError("WISP_TASK_ID is required for an inner command")
    if environ.get("WISP_WORKTREE") != str(EXPOSED_WORKTREE_ROOT / relative.name):
        raise ValueError("WISP_WORKTREE does not match the inner command cwd")

    task_env = {
        name: environ[name]
        for name in ("WISP_TASK_ID", "WISP_TASK_SLOT", "WISP_WORKTREE", "WISP_REPO")
        if name in environ
    }
    return {
        "argv": argv,
        "worktree": relative.name,
        "taskEnv": task_env,
    }


def write_stream(stream: object, encoded: str) -> None:
    data = base64.b64decode(encoded, validate=True)
    target = stream.buffer  # type: ignore[attr-defined]
    target.write(data)
    target.flush()


def stdin_frame(data: bytes) -> bytes:
    payload = {
        "stream": "stdin",
        "data": base64.b64encode(data).decode("ascii"),
    }
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > MAX_FRAME_BYTES:
        raise ValueError("inner Droid stdin frame is too large")
    return encoded


def forward_stdin(connection: socket.socket) -> None:
    try:
        while data := os.read(sys.stdin.fileno(), MAX_INPUT_CHUNK):
            connection.sendall(stdin_frame(data))
        connection.sendall(b'{"type":"stdin_end"}\n')
    except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
        # The worker or child exited first; the response loop reports its exit.
        return


def main(argv: list[str]) -> int:
    try:
        payload = request_payload(argv, Path.cwd(), dict(os.environ))
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_FRAME_BYTES:
            raise ValueError("inner Droid request is too large")

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(str(SOCKET_PATH))
            connection.sendall(encoded + b"\n")
            threading.Thread(target=forward_stdin, args=(connection,), daemon=True).start()
            reader = connection.makefile("rb")
            while True:
                line = reader.readline(MAX_FRAME_BYTES + 1)
                if not line:
                    raise RuntimeError("inner worker disconnected before reporting an exit")
                if len(line) > MAX_FRAME_BYTES:
                    raise RuntimeError("inner worker sent an oversized frame")
                frame = json.loads(line)
                if frame.get("stream") == "stdout":
                    write_stream(sys.stdout, frame["data"])
                elif frame.get("stream") == "stderr":
                    write_stream(sys.stderr, frame["data"])
                elif frame.get("type") == "exit":
                    return int(frame["code"])
                elif frame.get("type") == "error":
                    raise RuntimeError(str(frame.get("message", "inner worker error")))
                else:
                    raise RuntimeError("inner worker sent an unknown frame")
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"wisp evaluator inner client: {error}", file=sys.stderr)
        return 125


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
