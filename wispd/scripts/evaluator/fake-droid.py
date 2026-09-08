#!/usr/bin/env python3
"""Deterministic Droid-shaped process for evaluator infrastructure preflight."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

FIRST_TASK = "Implement case-insensitive substring filtering"
FOLLOW_UP = "Also ignore leading and trailing whitespace in the query"


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def respond(request: dict[str, object], result: dict[str, object]) -> None:
    emit({"jsonrpc": "2.0", "id": request["id"], "result": result})


def notify(notification: dict[str, object]) -> None:
    emit(
        {
            "jsonrpc": "2.0",
            "type": "notification",
            "method": "droid.session_notification",
            "params": {"notification": notification},
        }
    )


def commit(cwd: Path, message: str) -> None:
    subprocess.run(["git", "add", "textfilter.py", "test_textfilter.py"], cwd=cwd, check=True)
    subprocess.run(["git", "commit", "-m", message], cwd=cwd, check=True, stdout=subprocess.DEVNULL)


def first_turn(cwd: Path) -> str:
    (cwd / "textfilter.py").write_text(
        '''"""Small filtering utility used by the Wisp activation evaluator."""


def filter_lines(lines: list[str], query: str) -> list[str]:
    """Return case-insensitive substring matches in original order."""
    folded_query = query.casefold()
    return [line for line in lines if folded_query in line.casefold()]
''',
        encoding="utf-8",
    )
    test = cwd / "test_textfilter.py"
    text = test.read_text(encoding="utf-8")
    text = text.replace(
        "    def test_no_match_is_empty(self) -> None:\n",
        "    def test_matching_is_case_insensitive(self) -> None:\n"
        '        self.assertEqual(filter_lines(["Alpha", "beta", "ALPHABET"], "alp"), ["Alpha", "ALPHABET"])\n\n'
        "    def test_no_match_is_empty(self) -> None:\n",
    )
    test.write_text(text, encoding="utf-8")
    subprocess.run([sys.executable, "-m", "unittest"], cwd=cwd, check=True, stdout=subprocess.DEVNULL)
    commit(cwd, "feat: filter lines case-insensitively")
    return "Implemented case-insensitive filtering, added coverage, and committed the change."


def follow_up(cwd: Path) -> str:
    path = cwd / "textfilter.py"
    text = path.read_text(encoding="utf-8").replace(
        "folded_query = query.casefold()",
        "folded_query = query.strip().casefold()",
    )
    path.write_text(text, encoding="utf-8")
    test = cwd / "test_textfilter.py"
    text = test.read_text(encoding="utf-8")
    text = text.replace(
        "    def test_no_match_is_empty(self) -> None:\n",
        "    def test_query_edge_whitespace_is_ignored(self) -> None:\n"
        '        self.assertEqual(filter_lines(["Alpha", "beta"], "  alpha  "), ["Alpha"])\n\n'
        "    def test_no_match_is_empty(self) -> None:\n",
    )
    test.write_text(text, encoding="utf-8")
    subprocess.run([sys.executable, "-m", "unittest"], cwd=cwd, check=True, stdout=subprocess.DEVNULL)
    commit(cwd, "feat: trim filter queries")
    return "Trimmed query-edge whitespace, added coverage, and committed the follow-up."


def main(argv: list[str]) -> int:
    if argv == ["--version"]:
        print("droid 0.205.0-evaluator-fake")
        return 0
    if argv[:2] == ["doctor", "--auth"]:
        print('{"ok":true,"results":[]}')
        return 0
    if "--help" in argv:
        print("  -m, --model <id>  Model ID to use (default: fake-model)")
        return 0
    if "wisp-probe-not-a-model" in argv:
        print("Unknown model: wisp-probe-not-a-model", file=sys.stderr)
        print("Available built-in models:\n  fake-model", file=sys.stderr)
        return 1
    if not argv or argv[0] != "exec":
        print(f"fake droid: unsupported arguments: {argv!r}", file=sys.stderr)
        return 2

    cwd = Path.cwd()
    session = "fake-evaluator-session"
    for line in sys.stdin:
        request = json.loads(line)
        method = request.get("method")
        if method in {"droid.initialize_session", "droid.load_session"}:
            respond(
                request,
                {
                    "sessionId": session,
                    "settings": {"modelId": "fake-model", "reasoningEffort": "off"},
                },
            )
            continue
        if method == "droid.update_session_settings":
            respond(request, {})
            continue
        if method != "droid.add_user_message":
            emit(
                {
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "error": {"message": f"unsupported method: {method}"},
                }
            )
            continue

        params = request.get("params")
        prompt = params.get("text", "") if isinstance(params, dict) else ""
        message_id = params.get("messageId", "") if isinstance(params, dict) else ""
        respond(request, {})
        if FIRST_TASK in prompt:
            final = first_turn(cwd)
        elif FOLLOW_UP in prompt:
            final = follow_up(cwd)
        else:
            notify({"type": "agent_turn_completed", "reason": "failed", "turnId": message_id})
            notify({"type": "droid_working_state_changed", "newState": "idle"})
            continue
        notify(
            {
                "type": "create_message",
                "message": {
                    "id": f"assistant-{message_id}",
                    "role": "assistant",
                    "content": [{"type": "text", "text": final}],
                    "modelId": "fake-model",
                },
            }
        )
        notify(
            {
                "type": "agent_turn_completed",
                "reason": "completed",
                "turnId": message_id,
                "tokenUsage": {"inputTokens": 1, "outputTokens": 1},
            }
        )
        notify({"type": "droid_working_state_changed", "newState": "idle"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
