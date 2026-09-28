/** Disposable same-host services for the real-browser security check. */

/**
 * The other local service: same host, different port. This is the whole point
 * of SEC-01 — a host-scoped cookie is delivered here, and this records what
 * arrives.
 */
export function startOtherLocalService(port: number, daemonOrigin: string): Bun.Server<undefined> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/wisp-image-fixture.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } });
      if (url.pathname === "/cookies") {
        return new Response(JSON.stringify({ cookie: request.headers.get("cookie") }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/frame") {
        return new Response(
          `<!doctype html><title>frame</title><body><iframe id="f" src="${daemonOrigin}/"></iframe></body>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      return new Response("<!doctype html><title>other service</title><body>another local service</body>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
}

export function startHostRewritingProxy(daemonOrigin: string): Bun.Server<undefined> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      headers.set("accept-encoding", "identity");
      const url = new URL(request.url);
      const upstream = await fetch(`${daemonOrigin}${url.pathname}${url.search}`, {
        method: request.method, headers, redirect: "manual",
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });
}
