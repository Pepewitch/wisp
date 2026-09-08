#!/usr/bin/env python3
"""Aggregate independent evaluator case verdicts without grading model prose."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1])
    cases = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(root.glob("*/case.json"))
    ]
    if not cases:
        raise SystemExit("no evaluator cases found")
    summary = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "verdict": "pass" if all(case["verdict"] == "pass" for case in cases) else "fail",
        "cases": [
            {
                "case": case["case"],
                "verdict": case["verdict"],
                "failedOracles": [
                    oracle["name"] for oracle in case["oracles"] if oracle["status"] == "fail"
                ],
            }
            for case in cases
        ],
    }
    (root / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["verdict"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
