"""Authenticated, fail-closed egress for the Wisp evaluator.

The model container receives a syntactically plausible placeholder key. The
real revocable key exists only in this proxy sidecar. For approved Factory API
hosts, TLS interception replaces the placeholder Authorization header after it
has left the model's security boundary. No credential value is logged.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from mitmproxy import http

KEY_PATH = Path(os.environ.get("WISP_EVALUATOR_KEY_PATH", "/run/secrets/factory_api_key"))
LOG_PATH = Path(os.environ.get("WISP_EVALUATOR_NETWORK_LOG", "/evidence/network.jsonl"))
ALLOWED_HOSTS = tuple(
    host.strip().lower()
    for host in os.environ.get(
        "WISP_EVALUATOR_ALLOWED_HOSTS",
        "api.factory.ai,app.factory.ai",
    ).split(",")
    if host.strip()
)


def _allowed(host: str) -> bool:
    candidate = host.rstrip(".").lower()
    return any(candidate == allowed or candidate.endswith(f".{allowed}") for allowed in ALLOWED_HOSTS)


def _log(flow: http.HTTPFlow, decision: str) -> None:
    # Never retain query strings, bodies, request headers, response headers, or
    # credential material. This is an egress decision ledger, not a packet log.
    path = urlsplit(flow.request.pretty_url).path
    row = {
        "method": flow.request.method,
        "host": flow.request.pretty_host,
        "path": path,
        "decision": decision,
        "role": os.environ.get("WISP_EVALUATOR_PROXY_ROLE", "unspecified"),
    }
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")


def request(flow: http.HTTPFlow) -> None:
    host = flow.request.pretty_host
    if flow.request.scheme != "https" or not _allowed(host):
        _log(flow, "blocked")
        flow.response = http.Response.make(
            403,
            b"evaluator egress denied\n",
            {"content-type": "text/plain; charset=utf-8"},
        )
        return

    try:
        key = KEY_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        key = ""
    if not key:
        _log(flow, "blocked-empty-key")
        flow.response = http.Response.make(503, b"evaluator credential unavailable\n")
        return

    flow.request.headers["Authorization"] = f"Bearer {key}"
    _log(flow, "authorized")
