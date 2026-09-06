#!/usr/bin/env python3
"""Scripted install-to-phone journey that proves evaluator plumbing without API spend."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

FIRST_PROMPT = (
    "Implement case-insensitive substring filtering in textfilter.py, preserve "
    "result order, add or update tests, and commit the change."
)
FOLLOW_UP = (
    "Also ignore leading and trailing whitespace in the query, add coverage, "
    "and commit the follow-up."
)
HOME = Path.home()
WISP = HOME / ".local/bin/wisp"
EVIDENCE = Path("/evidence")


def timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(argv: list[str], *, stdout: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    if stdout:
        stdout.write_text(result.stdout + result.stderr, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(argv[:3])} exited {result.returncode}: {result.stderr[-500:]}")
    return result


def wait_health() -> None:
    for _ in range(100):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8710/api/health", timeout=1) as response:
                if json.load(response).get("ok") is True:
                    return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("Wisp daemon did not become healthy")


def browser(*args: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["agent-browser", *args],
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    with (EVIDENCE / "browser-journey.log").open("a", encoding="utf-8") as handle:
        handle.write(f"$ agent-browser {' '.join(args[:3])}\n")
        handle.write(result.stdout + result.stderr)
    if result.returncode != 0:
        diagnostic = subprocess.run(
            ["agent-browser", "snapshot", "--json"],
            text=True,
            capture_output=True,
            timeout=30,
        )
        (EVIDENCE / "browser-failure-snapshot.json").write_text(
            diagnostic.stdout + diagnostic.stderr,
            encoding="utf-8",
        )
        raise RuntimeError(f"agent-browser {' '.join(args[:3])} exited {result.returncode}: {result.stderr[-500:]}")
    return result


def main() -> int:
    (EVIDENCE / "started-at.txt").write_text(timestamp() + "\n", encoding="utf-8")
    (EVIDENCE / "auth-exit.txt").write_text("0\n", encoding="utf-8")
    (EVIDENCE / "model-exit.txt").write_text("0\n", encoding="utf-8")
    (EVIDENCE / "model.jsonl").write_text(
        '{"type":"preflight","detail":"deterministic fake Droid"}\n',
        encoding="utf-8",
    )
    (EVIDENCE / "model.stderr").write_text("", encoding="utf-8")
    (EVIDENCE / "network.jsonl").write_text("", encoding="utf-8")

    env = os.environ.copy()
    version = os.environ["WISP_EVALUATOR_VERSION"]
    env.update(
        {
            "WISP_ARTIFACT_PATH": f"/release/wisp-v{version}-linux-x86_64",
            "WISP_SHA256": os.environ["WISP_EVALUATOR_ARTIFACT_SHA256"],
            "WISP_COMMIT": os.environ["WISP_EVALUATOR_COMMIT"],
            "WISP_INSTALL_SERVICE": "no",
        }
    )
    install = subprocess.run(
        ["/bin/sh", "/release/install.sh"],
        env=env,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    (EVIDENCE / "install.log").write_text(install.stdout + install.stderr, encoding="utf-8")
    if install.returncode != 0:
        raise RuntimeError(f"release installer exited {install.returncode}; see install.log")

    daemon_log = (EVIDENCE / "daemon.log").open("w", encoding="utf-8")
    subprocess.Popen([str(WISP), "serve"], stdout=daemon_log, stderr=subprocess.STDOUT)
    wait_health()

    run([str(WISP), "project", "add", "/workspace/repo"], stdout=EVIDENCE / "project.log")
    run([str(WISP), "doctor", "--harness", "droid"], stdout=EVIDENCE / "doctor.log")
    created = run(
        [
            str(WISP),
            "new",
            "/workspace/repo",
            FIRST_PROMPT,
            "--harness",
            "droid",
            "--model",
            "fake-model",
        ],
        stdout=EVIDENCE / "create.log",
    )
    task_id = created.stdout.split()[1]
    run([str(WISP), "wait", task_id, "--timeout", "60"], stdout=EVIDENCE / "wait-first.log", timeout=70)

    browser("open", "http://127.0.0.1:8710")
    browser("set", "viewport", "390", "844")
    browser("network", "har", "start", "--content", "none")
    (EVIDENCE / "browser-ready.txt").write_text("1\n", encoding="utf-8")
    browser("open", "http://127.0.0.1:8710")
    token = json.loads((HOME / ".wisp/config.json").read_text(encoding="utf-8"))["token"]
    browser("find", "placeholder", "Paste the token", "fill", token)
    browser("find", "role", "button", "click", "--name", "Connect")
    browser("find", "placeholder", "Ask for changes, or / for commands", "fill", FOLLOW_UP)
    browser("press", "Enter")
    run([str(WISP), "wait", task_id, "--timeout", "60"], stdout=EVIDENCE / "wait-follow-up.log", timeout=70)
    browser("wait", "--text", "Trimmed query-edge whitespace")

    (EVIDENCE / "finished-at.txt").write_text(timestamp() + "\n", encoding="utf-8")
    os.environ["WISP_EVALUATOR_MODEL"] = "preflight-fake"
    return subprocess.run(["/opt/evaluator/collect-evidence.py"], check=False).returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        logs = HOME / ".wisp/logs"
        if logs.is_dir():
            shutil.copytree(logs, EVIDENCE / "wisp-logs", dirs_exist_ok=True)
        subprocess.run(["/opt/evaluator/redact-evidence.py"], check=False)
