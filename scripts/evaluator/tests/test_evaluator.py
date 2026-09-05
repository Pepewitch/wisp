from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_script(name: str):
    path = ROOT / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeDroidTest(unittest.TestCase):
    def test_serves_the_live_json_rpc_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            shutil.copy(ROOT / "fixture/textfilter.py", repo / "textfilter.py")
            shutil.copy(ROOT / "fixture/test_textfilter.py", repo / "test_textfilter.py")
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Wisp Evaluator"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "wisp-evaluator@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)

            process = subprocess.Popen(
                [sys.executable, str(ROOT / "fake-droid.py"), "exec", "-o", "stream-json"],
                cwd=repo,
                text=True,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertIsNotNone(process.stdin)
            self.assertIsNotNone(process.stdout)

            def exchange(payload: dict[str, object]) -> dict[str, object]:
                assert process.stdin is not None
                assert process.stdout is not None
                process.stdin.write(json.dumps(payload) + "\n")
                process.stdin.flush()
                return json.loads(process.stdout.readline())

            initialized = exchange(
                {"jsonrpc": "2.0", "id": "1", "method": "droid.initialize_session", "params": {}}
            )
            self.assertEqual(initialized["result"]["sessionId"], "fake-evaluator-session")
            admitted = exchange(
                {
                    "jsonrpc": "2.0",
                    "id": "2",
                    "method": "droid.add_user_message",
                    "params": {"messageId": "first", "text": FIRST_PROMPT_FOR_TEST},
                }
            )
            self.assertEqual(admitted["result"], {})
            assert process.stdout is not None
            notifications = [json.loads(process.stdout.readline()) for _ in range(3)]
            self.assertEqual(
                [frame["params"]["notification"]["type"] for frame in notifications],
                ["create_message", "agent_turn_completed", "droid_working_state_changed"],
            )
            self.assertEqual(
                notifications[0]["params"]["notification"]["message"]["content"][0]["text"],
                "Implemented case-insensitive filtering, added coverage, and committed the change.",
            )
            assert process.stdin is not None
            process.stdin.close()
            returncode = process.wait(timeout=5)
            stderr = process.stderr.read() if process.stderr else ""
            process.stdout.close()
            if process.stderr:
                process.stderr.close()
            self.assertEqual(returncode, 0, stderr)
            self.assertEqual(
                subprocess.run(
                    ["git", "log", "-1", "--format=%s"],
                    cwd=repo,
                    check=True,
                    text=True,
                    capture_output=True,
                ).stdout.strip(),
                "feat: filter lines case-insensitively",
            )


FIRST_PROMPT_FOR_TEST = (
    "Implement case-insensitive substring filtering in textfilter.py, preserve "
    "result order, add or update tests, and commit the change."
)


class HiddenOracleTest(unittest.TestCase):
    def test_rejects_initial_fixture_and_accepts_complete_behavior(self) -> None:
        initial = subprocess.run(
            [sys.executable, str(ROOT / "hidden-oracle.py"), str(ROOT / "fixture")],
            text=True,
            capture_output=True,
        )
        self.assertNotEqual(initial.returncode, 0)
        self.assertFalse(json.loads(initial.stdout)["ok"])

        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / "textfilter.py").write_text(
                "def filter_lines(lines, query):\n"
                "    needle = query.strip().casefold()\n"
                "    return [line for line in lines if needle in line.casefold()]\n",
                encoding="utf-8",
            )
            complete = subprocess.run(
                [sys.executable, str(ROOT / "hidden-oracle.py"), str(repo)],
                text=True,
                capture_output=True,
            )
            self.assertEqual(complete.returncode, 0, complete.stderr)
            self.assertTrue(json.loads(complete.stdout)["ok"])
            self.assertFalse((repo / "__pycache__").exists())


class CaseValidationTest(unittest.TestCase):
    def test_verdict_must_match_oracles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.json"
            case = {
                "schemaVersion": 1,
                "case": "model",
                "verdict": "pass",
                "baseline": {},
                "process": {},
                "oracles": [{"name": "one", "status": "pass", "detail": "ok"}],
                "artifacts": [],
            }
            path.write_text(json.dumps(case), encoding="utf-8")
            valid = subprocess.run(
                [sys.executable, str(ROOT / "validate-case.py"), str(path)],
                text=True,
                capture_output=True,
            )
            self.assertEqual(valid.returncode, 0, valid.stderr)

            case["oracles"][0]["status"] = "fail"
            path.write_text(json.dumps(case), encoding="utf-8")
            invalid = subprocess.run(
                [sys.executable, str(ROOT / "validate-case.py"), str(path)],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("disagrees", invalid.stderr)


class AggregationTest(unittest.TestCase):
    def test_any_failed_case_fails_summary(self) -> None:
        aggregate = load_script("aggregate.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, verdict in (("a", "pass"), ("b", "fail")):
                case_dir = root / name
                case_dir.mkdir()
                (case_dir / "case.json").write_text(
                    json.dumps(
                        {
                            "case": name,
                            "verdict": verdict,
                            "oracles": [
                                {
                                    "name": "oracle",
                                    "status": verdict,
                                    "detail": verdict,
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
            original = sys.argv
            try:
                sys.argv = ["aggregate.py", str(root)]
                self.assertEqual(aggregate.main(), 1)
            finally:
                sys.argv = original
            summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["verdict"], "fail")
            self.assertEqual(summary["cases"][1]["failedOracles"], ["oracle"])


class LeakScanTest(unittest.TestCase):
    def test_real_key_is_scrubbed_and_fails_case(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            secret = "fk-test-secret-abcdefghijklmnop"
            key = root / "key"
            key.write_text(secret, encoding="utf-8")
            evidence = root / "evidence"
            evidence.mkdir()
            (evidence / "model.log").write_text(f"oops {secret}\n", encoding="utf-8")
            (evidence / "case.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "case": "test",
                        "verdict": "pass",
                        "baseline": {},
                        "process": {},
                        "oracles": [{"name": "base", "status": "pass", "detail": "ok"}],
                        "artifacts": [],
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scan-evidence.py"),
                    "--evidence",
                    str(evidence),
                    "--key-file",
                    str(key),
                    "--placeholder",
                    "fk-evaluator-placeholder-00000000000000000000",
                ],
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(secret, (evidence / "model.log").read_text(encoding="utf-8"))
            case = json.loads((evidence / "case.json").read_text(encoding="utf-8"))
            self.assertEqual(case["verdict"], "fail")
            self.assertEqual(case["oracles"][-1]["name"], "credential leak scan")
            self.assertEqual(case["oracles"][-1]["status"], "fail")

    def test_placeholder_is_scrubbed_without_failing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            placeholder = "fk-evaluator-placeholder-00000000000000000000"
            (evidence / "model.log").write_text(placeholder, encoding="utf-8")
            (evidence / "case.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "case": "test",
                        "verdict": "pass",
                        "baseline": {},
                        "process": {},
                        "oracles": [{"name": "base", "status": "pass", "detail": "ok"}],
                        "artifacts": [],
                    }
                ),
                encoding="utf-8",
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scan-evidence.py"),
                    "--evidence",
                    str(evidence),
                    "--placeholder",
                    placeholder,
                ],
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            case = json.loads((evidence / "case.json").read_text(encoding="utf-8"))
            self.assertEqual(case["verdict"], "pass")


class InnerWorkerTest(unittest.TestCase):
    def test_relay_accepts_only_bounded_base64_stdin_frames(self) -> None:
        client = load_script("inner-client.py")
        worker = load_script("inner-worker.py")
        data = b'{"jsonrpc":"2.0","id":"1"}\n'
        frame = json.loads(client.stdin_frame(data))
        self.assertEqual(worker.decode_stdin_frame(frame), data)
        self.assertIsNone(worker.decode_stdin_frame({"type": "stdin_end"}))
        for invalid in (
            {"stream": "stdout", "data": ""},
            {"stream": "stdin", "data": "***"},
            {"type": "stdin_end", "extra": True},
            {"stream": "stdin", "data": "eA==", "extra": True},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    worker.decode_stdin_frame(invalid)

    def test_maps_only_one_existing_worktree_component(self) -> None:
        worker = load_script("inner-worker.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worktree = root / "repo-task"
            worktree.mkdir()
            self.assertEqual(worker.map_worktree("repo-task", root), worktree.resolve())
            for invalid in ("", ".", "..", "../escape", "nested/path", "/absolute"):
                with self.subTest(invalid=invalid):
                    with self.assertRaises(ValueError):
                        worker.map_worktree(invalid, root)

    def test_accepts_only_wisp_default_droid_argv(self) -> None:
        worker = load_script("inner-worker.py")
        valid = [
            "exec",
            "-o",
            "stream-json",
            "--skip-permissions-unsafe",
            "-s",
            "session-id",
            "-m",
            "glm-5.2-fast",
            "-r",
            "medium",
            "prompt",
        ]
        self.assertEqual(worker.validate_argv(valid), valid)
        for invalid in (
            ["doctor", "--auth"],
            ["exec", "--cwd", "/home/inner", "prompt"],
            ["exec", "-o", "stream-json", "--skip-permissions-unsafe", "--file", "/secret"],
            [
                "exec",
                "-o",
                "stream-json",
                "--skip-permissions-unsafe",
                "-m",
                "account-default",
                "prompt",
            ],
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    worker.validate_argv(invalid)

    def test_client_rejects_non_exec_and_nested_cwd(self) -> None:
        client = load_script("inner-client.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worktree = root / "repo-task"
            nested = worktree / "nested"
            nested.mkdir(parents=True)
            original = client.WORKTREE_ROOT
            client.WORKTREE_ROOT = root
            try:
                with self.assertRaises(ValueError):
                    client.request_payload(["doctor"], worktree, {"WISP_TASK_ID": "t12345"})
                with self.assertRaises(ValueError):
                    client.request_payload(["exec", "prompt"], nested, {"WISP_TASK_ID": "t12345"})
                payload = client.request_payload(
                    ["exec", "prompt"],
                    worktree,
                    {
                        "WISP_TASK_ID": "t12345",
                        "WISP_TASK_SLOT": "1",
                        "WISP_WORKTREE": str(client.EXPOSED_WORKTREE_ROOT / "repo-task"),
                        "IGNORED_SECRET": "no",
                    },
                )
            finally:
                client.WORKTREE_ROOT = original
            self.assertEqual(payload["worktree"], "repo-task")
            self.assertEqual(
                payload["taskEnv"],
                {
                    "WISP_TASK_ID": "t12345",
                    "WISP_TASK_SLOT": "1",
                    "WISP_WORKTREE": str(client.EXPOSED_WORKTREE_ROOT / "repo-task"),
                },
            )


class RunnerConfigurationTest(unittest.TestCase):
    def test_one_syntactically_plausible_placeholder_feeds_both_droids(self) -> None:
        script = (ROOT / "run.sh").read_text(encoding="utf-8")
        assignment = next(
            line for line in script.splitlines() if line.startswith("PLACEHOLDER_KEY=")
        )
        placeholder = assignment.split("=", 1)[1].strip('"')
        self.assertTrue(placeholder.startswith("fk-"))
        self.assertGreaterEqual(len(placeholder), 32)
        self.assertEqual(script.count('--env "FACTORY_API_KEY=$PLACEHOLDER_KEY"'), 2)
        self.assertEqual(script.count('--placeholder "$PLACEHOLDER_KEY"'), 2)

    def test_handoff_blocks_until_evidence_is_collected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, "WISP_EVALUATOR_HANDOFF_DIR": directory}
            process = subprocess.Popen(
                [str(ROOT / "evaluator-handoff.sh")],
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            ready = Path(directory) / "wisp-evaluator-ready"
            for _ in range(100):
                if ready.exists():
                    break
                process.poll()
                if process.returncode is not None:
                    break
                time.sleep(0.01)
            self.assertTrue(ready.exists())
            self.assertIsNone(process.poll())
            (Path(directory) / "wisp-evaluator-collected").touch()
            _, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
