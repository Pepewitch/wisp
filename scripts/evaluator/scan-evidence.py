#!/usr/bin/env python3
"""Host-side secret leak scan and final scrub for evaluator evidence."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

KEY_PATTERN = re.compile(rb"\bfk-[A-Za-z0-9_-]{12,}\b")
BEARER_PATTERN = re.compile(rb"(?i)(authorization[\"']?\s*[:=]\s*[\"']?bearer\s+)[^\"'\s,}]+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--key-file", type=Path)
    parser.add_argument("--placeholder", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    secret = args.key_file.read_bytes().strip() if args.key_file else b""
    placeholder = args.placeholder.encode()
    leaked_files: set[str] = set()
    generic_files: set[str] = set()
    scrubbed = 0

    files = [path for path in args.evidence.rglob("*") if path.is_file() and not path.is_symlink()]
    for path in files:
        if path.stat().st_size > 100_000_000:
            continue
        data = path.read_bytes()
        original = data
        if secret and secret in data:
            leaked_files.add(str(path.relative_to(args.evidence)))
            data = data.replace(secret, b"[REDACTED_FACTORY_KEY]")
        for match in KEY_PATTERN.findall(data):
            if match != placeholder:
                generic_files.add(str(path.relative_to(args.evidence)))
        data = KEY_PATTERN.sub(b"[REDACTED_FACTORY_KEY_SHAPED]", data)
        data = BEARER_PATTERN.sub(rb"\1[REDACTED_BEARER]", data)
        if data != original:
            path.write_bytes(data)
            scrubbed += 1

    case_path = args.evidence / "case.json"
    if not case_path.exists():
        raise SystemExit("case.json missing; evaluator did not produce a verdict")
    case = json.loads(case_path.read_text(encoding="utf-8"))
    passed = not leaked_files and not generic_files
    case["oracles"].append(
        {
            "name": "credential leak scan",
            "status": "pass" if passed else "fail",
            "detail": (
                "real key absent and no unexpected Factory-key-shaped value remained"
                if passed
                else f"credential material found in {sorted(leaked_files | generic_files)} and scrubbed"
            ),
        }
    )
    if not passed:
        case["verdict"] = "fail"
    case_path.write_text(json.dumps(case, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    report = {
        "leaksFound": len(leaked_files),
        "keyShapedFiles": len(generic_files),
        "filesScrubbed": scrubbed,
        "passed": passed,
    }
    (args.evidence / "leak-scan.json").write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"credentialLeakScan": "pass" if passed else "fail", "filesScrubbed": scrubbed}))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
