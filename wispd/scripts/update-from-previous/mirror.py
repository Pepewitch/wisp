"""A fail-closed stand-in for GitHub in the update-from-previous gate.

The previous release runs unmodified, so it fetches its hard-coded https URLs:
the tap's update channel on raw.githubusercontent.com and the release
manifest and artifact on github.com. The gate answers those names with this
server, on an internal Docker network, behind a throwaway test CA. It serves
exactly the candidate's channel, manifest, and artifact, and answers anything
else 404 with an `unexpected` log line the gate fails on, so a new request in
the update path is noticed instead of silently reaching the internet.

It also answers the commit lookup a channel reader may make first
(api.github.com .../commits/main as a bare SHA, then the channel at that SHA),
so a release that pins its channel read to a tap commit is covered too.
"""

from __future__ import annotations

import json
import os
import shutil
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

TAP = "Pepewitch/homebrew-tap"
REPO = "Pepewitch/wisp"
# Any fixed 40-hex value: the mirror is the only tap there is.
TAP_COMMIT = "0" * 39 + "1"


def routes(version: str) -> dict[tuple[str, str], tuple[str, str]]:
    channel = ("/mirror/channel.json", "application/json")
    release = f"/{REPO}/releases/download/v{version}"
    return {
        ("raw.githubusercontent.com", f"/{TAP}/main/updates/wisp-daemon.json"): channel,
        ("raw.githubusercontent.com", f"/{TAP}/{TAP_COMMIT}/updates/wisp-daemon.json"): channel,
        ("api.github.com", f"/repos/{TAP}/commits/main"): ("sha", "application/vnd.github.sha"),
        ("github.com", f"{release}/release-manifest.json"): (
            "/mirror/release-manifest.json",
            "application/octet-stream",
        ),
        ("github.com", f"{release}/wisp-v{version}-linux-x86_64"): (
            "/mirror/artifact",
            "application/octet-stream",
        ),
    }


def log(**fields: object) -> None:
    print(json.dumps(fields, sort_keys=True), flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    table: dict[tuple[str, str], tuple[str, str]] = {}

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass

    def do_GET(self) -> None:  # noqa: N802
        host = (self.headers.get("host") or "").split(":")[0].lower()
        path = urlsplit(self.path).path
        route = self.table.get((host, path))
        if route is None:
            log(event="unexpected", method="GET", host=host, path=path)
            self.send_error(404, "not served by the update-from-previous mirror")
            return
        source, content_type = route
        if source == "sha":
            body = TAP_COMMIT.encode()
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            size = os.path.getsize(source)
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(size))
            self.end_headers()
            with open(source, "rb") as file:
                shutil.copyfileobj(file, self.wfile, 1024 * 1024)
        log(event="served", method="GET", host=host, path=path)

    def do_unexpected(self) -> None:
        host = (self.headers.get("host") or "").split(":")[0].lower()
        log(event="unexpected", method=self.command, host=host, path=urlsplit(self.path).path)
        self.send_error(405, "only GET is served by the update-from-previous mirror")

    do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_unexpected  # noqa: N815


class Server(ThreadingHTTPServer):
    daemon_threads = True
    context: ssl.SSLContext

    def finish_request(self, request, client_address) -> None:  # type: ignore[no-untyped-def]
        # The handshake runs on the worker thread, and a client that refuses
        # the test CA is logged: that is the first thing to read when the
        # previous release stops trusting it.
        try:
            connection = self.context.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError) as error:
            log(event="unexpected", tls_error=str(error))
            return
        self.RequestHandlerClass(connection, client_address, self)


def main() -> int:
    version = sys.argv[1]
    Handler.table = routes(version)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain("/certs/server.pem", "/certs/server.key")
    server = Server(("0.0.0.0", 443), Handler)
    server.context = context
    log(event="listening", version=version)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
