/* Replaced with the standalone recovery document by the daemon. No runtime
   data or application responses ever enter Cache Storage. */
const OFFLINE_HTML = __WISP_OFFLINE_HTML__;
const OFFLINE_CSP = __WISP_OFFLINE_CSP__;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // In particular, never intercept API, attachment, stream or cross-origin traffic.
  if (request.method !== "GET" || request.mode !== "navigate" ||
      url.origin !== self.location.origin ||
      (url.pathname !== "/" && url.pathname !== "/index.html")) return;
  event.respondWith(navigate(request));
});

async function navigate(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    // Always use the current daemon UI; updates never leave a stale shell behind.
    const response = await fetch(request, { cache: "no-store", signal: controller.signal });
    if (![502, 503, 504].includes(response.status)) return response;
    await response.body?.cancel();
  } catch {
    // A sleeping server, lost tailnet route, or airplane mode all need recovery.
  } finally {
    clearTimeout(timeout);
  }
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": OFFLINE_CSP,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
