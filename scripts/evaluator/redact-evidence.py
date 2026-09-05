#!/usr/bin/env python3
"""Redact disposable Wisp credentials and credential-shaped strings in evidence."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path("/evidence")
TEXT_SUFFIXES = {
    "",
    ".json",
    ".jsonl",
    ".log",
    ".md",
    ".stderr",
    ".txt",
    ".har",
}
BEARER = re.compile(r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?bearer\s+)[^\"'\s,}]+")


def main() -> int:
    wisp_token = ""
    config = Path.home() / ".wisp/config.json"
    if config.exists():
        try:
            wisp_token = json.loads(config.read_text(encoding="utf-8")).get("token", "")
        except (json.JSONDecodeError, OSError):
            pass

    replacements = 0
    files = 0
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES or path.stat().st_size > 50_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        original = text
        if wisp_token:
            count = text.count(wisp_token)
            replacements += count
            text = text.replace(wisp_token, "[REDACTED_WISP_TOKEN]")
        text, count = BEARER.subn(r"\1[REDACTED_BEARER]", text)
        replacements += count
        if text != original:
            path.write_text(text, encoding="utf-8")
            files += 1

    report = {"filesChanged": files, "replacements": replacements}
    (ROOT / "redaction.json").write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
