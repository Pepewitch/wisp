#!/usr/bin/env python3
"""Deterministic task oracle kept outside the repository shown to the model."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def main() -> int:
    repo = Path(sys.argv[1]).resolve()
    module_path = repo / "textfilter.py"
    spec = importlib.util.spec_from_file_location("evaluated_textfilter", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    cases = [
        (
            ["Alpha", "BETA", "alphabet", "gamma"],
            "ALP",
            ["Alpha", "alphabet"],
            "case-insensitive substring",
        ),
        (
            [" Alpha ", "beta", "ALPHABET", "gamma"],
            "  alpha  ",
            [" Alpha ", "ALPHABET"],
            "query edge whitespace",
        ),
        (
            ["second", "FIRST", "third", "first again"],
            "first",
            ["FIRST", "first again"],
            "stable result order",
        ),
        (["alpha", "beta"], "  Z  ", [], "empty result"),
    ]
    failures: list[str] = []
    for lines, query, expected, name in cases:
        actual = module.filter_lines(lines, query)
        if actual != expected:
            failures.append(f"{name}: expected {expected!r}, got {actual!r}")
    result = {"ok": not failures, "failures": failures, "cases": len(cases)}
    print(json.dumps(result, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
