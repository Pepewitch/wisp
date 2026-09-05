#!/usr/bin/env python3
"""Collect objective Wisp evaluator evidence and emit the case verdict."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EVIDENCE = Path("/evidence")
HOME = Path.home()
WISP_HOME = HOME / ".wisp"
FOLLOW_UP = (
    "Also ignore leading and trailing whitespace in the query, add coverage, "
    "and commit the follow-up."
)
INNER_MODEL = os.environ.get("WISP_EVALUATOR_INNER_MODEL", "glm-5.2-fast")


def run(argv: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=cwd, text=True, capture_output=True, timeout=60)


def check(name: str, passed: bool, detail: str) -> dict[str, str]:
    return {"name": name, "status": "pass" if passed else "fail", "detail": detail}


def capture_browser() -> list[dict[str, str]]:
    browser_dir = EVIDENCE / "browser"
    browser_dir.mkdir(exist_ok=True)
    commands = {
        "final-snapshot.json": ["agent-browser", "snapshot", "--json"],
        "console.json": ["agent-browser", "console", "--json"],
        "errors.json": ["agent-browser", "errors", "--json"],
        "requests.json": ["agent-browser", "network", "requests", "--json"],
    }
    findings: list[dict[str, str]] = []
    for filename, argv in commands.items():
        result = run(argv)
        (browser_dir / filename).write_text(result.stdout + result.stderr, encoding="utf-8")
        findings.append(check(f"browser capture {filename}", result.returncode == 0, f"exit {result.returncode}"))
    screenshot = run(["agent-browser", "screenshot", str(browser_dir / "final.png")])
    findings.append(check("browser screenshot", screenshot.returncode == 0, f"exit {screenshot.returncode}"))
    har = run(["agent-browser", "network", "har", "stop", str(browser_dir / "trace.har")])
    (browser_dir / "har-stop.log").write_text(har.stdout + har.stderr, encoding="utf-8")
    findings.append(check("browser HAR", har.returncode == 0, f"exit {har.returncode}"))
    run(["agent-browser", "close"])
    return findings


def capture_diagnostics() -> None:
    roots = ((WISP_HOME / "logs", EVIDENCE / "wisp-logs"),)
    for source, destination in roots:
        if not source.is_dir():
            continue
        for path in source.rglob("*"):
            if not path.is_file() or path.is_symlink() or path.stat().st_size > 50_000_000:
                continue
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
    background = EVIDENCE / "outer-background"
    for path in Path("/tmp").glob("droid-bg-*.out"):
        if path.is_file() and not path.is_symlink() and path.stat().st_size <= 50_000_000:
            background.mkdir(exist_ok=True)
            shutil.copyfile(path, background / path.name)


def api_get(path: str, token: str | None = None) -> tuple[int, Any]:
    request = urllib.request.Request(f"http://127.0.0.1:8710{path}")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError):
        return 0, None


def parse_iso(path: Path) -> str | None:
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def main() -> int:
    capture_diagnostics()
    findings = capture_browser()
    model = os.environ.get("WISP_EVALUATOR_MODEL", "unknown")
    manifest = json.loads(Path("/release/release-manifest.json").read_text(encoding="utf-8"))
    config_path = WISP_HOME / "config.json"
    db_path = WISP_HOME / "wisp.db"
    token = ""
    if config_path.exists():
        token = json.loads(config_path.read_text(encoding="utf-8")).get("token", "")

    health_status, health = api_get("/api/health")
    expected_identity = {
        "version": manifest["version"],
        "commit": manifest["commit"],
        "dirty": False,
    }
    actual_identity = (
        {key: health.get(key) for key in expected_identity}
        if isinstance(health, dict)
        else None
    )
    findings.append(
        check(
            "daemon build identity",
            health_status == 200 and actual_identity == expected_identity,
            f"expected {expected_identity}, got {actual_identity}",
        )
    )

    tasks: list[sqlite3.Row] = []
    turns: list[sqlite3.Row] = []
    if db_path.exists():
        connection = sqlite3.connect(db_path)
        connection.row_factory = sqlite3.Row
        tasks = connection.execute("SELECT * FROM tasks WHERE archived = 0 ORDER BY created_at").fetchall()
        if len(tasks) == 1:
            turns = connection.execute(
                "SELECT * FROM turns WHERE task_id = ? ORDER BY n",
                (tasks[0]["id"],),
            ).fetchall()
        connection.close()
    findings.append(check("single Wisp task", len(tasks) == 1, f"found {len(tasks)} active tasks"))

    task = tasks[0] if len(tasks) == 1 else None
    findings.append(
        check(
            "pinned inner Droid model",
            bool(task and task["harness"] == "droid" and task["model"] == INNER_MODEL),
            f"expected droid/{INNER_MODEL}, got "
            f"{task['harness'] if task else None}/{task['model'] if task else None}",
        )
    )
    task_id = task["id"] if task else None
    detail_status, detail = api_get(f"/api/tasks/{task_id}", token) if task_id and token else (0, None)
    findings.append(
        check(
            "task lifecycle",
            bool(task and task["state"] == "done" and task["turn_count"] == 2 and detail_status == 200),
            f"state={task['state'] if task else None}, turns={task['turn_count'] if task else 0}, api={detail_status}",
        )
    )
    findings.append(
        check(
            "Droid session resumed",
            len(turns) == 2
            and all(turn["status"] == "done" and turn["exit_code"] == 0 for turn in turns)
            and bool(task and task["session_id"]),
            f"turn statuses={[turn['status'] for turn in turns]}",
        )
    )
    findings.append(
        check(
            "browser follow-up persisted",
            len(turns) == 2 and turns[1]["prompt"] == FOLLOW_UP,
            "turn 2 prompt matches the required browser-only follow-up"
            if len(turns) == 2 and turns[1]["prompt"] == FOLLOW_UP
            else "required follow-up was not persisted as turn 2",
        )
    )

    worktree = Path(task["worktree_path"]) if task and task["worktree_path"] else None
    hidden = run(["/opt/evaluator/hidden-oracle.py", str(worktree)]) if worktree else None
    if hidden:
        (EVIDENCE / "task-oracle.json").write_text(hidden.stdout + hidden.stderr, encoding="utf-8")
    findings.append(
        check(
            "hidden task oracle",
            bool(hidden and hidden.returncode == 0),
            hidden.stdout.strip() if hidden else "task worktree unavailable",
        )
    )

    git_status = run(["git", "status", "--porcelain=v1"], worktree) if worktree else None
    commit_count = (
        run(["git", "rev-list", "--count", f"{task['base_commit']}..HEAD"], worktree)
        if worktree and task
        else None
    )
    branch = run(["git", "branch", "--show-current"], worktree) if worktree else None
    git_ok = bool(
        git_status
        and git_status.returncode == 0
        and git_status.stdout == ""
        and commit_count
        and commit_count.returncode == 0
        and int(commit_count.stdout.strip()) >= 2
        and branch
        and task_id
        and branch.stdout.strip().startswith(f"wisp/{task_id}-")
    )
    findings.append(
        check(
            "isolated Git worktree",
            git_ok,
            f"branch={branch.stdout.strip() if branch else None}, "
            f"commits={commit_count.stdout.strip() if commit_count else None}, "
            f"clean={bool(git_status and git_status.stdout == '')}",
        )
    )
    base_before = parse_iso(EVIDENCE / "fixture-base-commit.txt")
    base_after = run(["git", "rev-parse", "HEAD"], Path("/workspace/repo"))
    findings.append(
        check(
            "source checkout unchanged",
            base_after.returncode == 0 and base_after.stdout.strip() == base_before,
            f"base remained {base_before}",
        )
    )

    snapshot_text = (EVIDENCE / "browser/final-snapshot.json").read_text(encoding="utf-8", errors="replace")
    request_text = (EVIDENCE / "browser/requests.json").read_text(encoding="utf-8", errors="replace")
    findings.append(
        check(
            "phone-sized browser flow",
            (EVIDENCE / "browser-ready.txt").read_text().strip() == "1"
            and FOLLOW_UP in snapshot_text
            and "/api/tasks/" in request_text,
            "390x844 browser captured the required follow-up and task API traffic",
        )
    )
    console_text = (EVIDENCE / "browser/console.json").read_text(encoding="utf-8", errors="replace")
    error_text = (EVIDENCE / "browser/errors.json").read_text(encoding="utf-8", errors="replace")
    findings.append(
        check(
            "browser runtime errors",
            '"type":"error"' not in console_text.replace(" ", "").lower()
            and '"errors":[]' in error_text.replace(" ", "").lower(),
            "no browser page errors captured",
        )
    )

    auth_exit = int(parse_iso(EVIDENCE / "auth-exit.txt") or "0")
    model_exit = int(parse_iso(EVIDENCE / "model-exit.txt") or "0")
    findings.append(check("Droid auth preflight", auth_exit == 0, f"exit {auth_exit}"))
    findings.append(check("model process", model_exit == 0, f"exit {model_exit}"))

    passed = all(finding["status"] == "pass" for finding in findings)
    case = {
        "schemaVersion": 1,
        "case": model,
        "verdict": "pass" if passed else "fail",
        "startedAt": parse_iso(EVIDENCE / "started-at.txt"),
        "finishedAt": parse_iso(EVIDENCE / "finished-at.txt")
        or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "baseline": {
            "image": os.environ.get("WISP_EVALUATOR_BASE_IMAGE", "unknown"),
            "evaluatorImage": os.environ.get("WISP_EVALUATOR_IMAGE_ID", "unknown"),
            "droidVersion": os.environ.get("WISP_EVALUATOR_DROID_VERSION", "0.205.0"),
            "agentBrowserVersion": os.environ.get("WISP_EVALUATOR_BROWSER_VERSION", "0.35.0"),
            "chromeVersion": os.environ.get("WISP_EVALUATOR_CHROME_VERSION", "152.0.7977.75"),
            "innerIsolation": "dedicated-container",
            "innerModel": INNER_MODEL,
            "wisp": expected_identity,
            "viewport": {"width": 390, "height": 844},
        },
        "process": {"authExit": auth_exit, "modelExit": model_exit},
        "oracles": findings,
        "artifacts": [
            "model.jsonl",
            "model.stderr",
            "doctor.log",
            "daemon.log",
            "task-oracle.json",
            "network.jsonl",
            "inner-worker.log",
            "inner-droid-auth.json",
            "inner-droid-logs",
            "browser/final-snapshot.json",
            "browser/final.png",
            "browser/trace.har",
            "browser/console.json",
            "browser/errors.json",
            "browser/requests.json",
        ],
    }
    (EVIDENCE / "case.json").write_text(json.dumps(case, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"case": model, "verdict": case["verdict"]}, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
