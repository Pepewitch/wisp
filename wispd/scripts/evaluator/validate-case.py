#!/usr/bin/env python3
"""Minimal dependency-free validation for the committed evaluator schema."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    required = {"schemaVersion", "case", "verdict", "baseline", "process", "oracles", "artifacts"}
    missing = sorted(required - data.keys())
    if missing:
        raise SystemExit(f"case evidence missing fields: {', '.join(missing)}")
    if data["schemaVersion"] != 1:
        raise SystemExit("unsupported case evidence schema")
    if data["verdict"] not in {"pass", "fail"}:
        raise SystemExit("case verdict must be pass or fail")
    if not isinstance(data["oracles"], list) or not data["oracles"]:
        raise SystemExit("case oracles must be a non-empty list")
    for index, oracle in enumerate(data["oracles"]):
        if set(oracle) != {"name", "status", "detail"}:
            raise SystemExit(f"oracle {index} has an invalid shape")
        if oracle["status"] not in {"pass", "fail"}:
            raise SystemExit(f"oracle {index} has an invalid status")
    expected = "pass" if all(oracle["status"] == "pass" for oracle in data["oracles"]) else "fail"
    if data["verdict"] != expected:
        raise SystemExit(f"case verdict {data['verdict']} disagrees with oracle verdict {expected}")
    print(f"valid evaluator case: {data['case']} ({data['verdict']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
