import icon192 from "../../brand/pwa-icon-192.png" with { type: "file" };
import icon512 from "../../brand/pwa-icon-512.png" with { type: "file" };
import touchIcon from "../../brand/apple-touch-icon.png" with { type: "file" };
import mark from "../../brand/favicon.svg" with { type: "text" };
import offline from "../../web/pwa/offline.html" with { type: "text" };
import worker from "../../web/pwa/sw.js" with { type: "text" };
import { contentSecurityPolicy, pageSecurityPolicy } from "./routes/security-headers";

const manifest = JSON.stringify({
  id: "/", name: "Wisp", short_name: "Wisp", lang: "en",
  description: "Your coding tasks, wherever you are.",
  start_url: "/", scope: "/", display: "standalone",
  background_color: "#19191d", theme_color: "#19191d",
  icons: [
    { src: "/icons/wisp-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/wisp-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/wisp-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

const offlineHtml = (offline as unknown as string).replace("__WISP_MARK__", mark);
const offlinePolicy = contentSecurityPolicy(pageSecurityPolicy(offlineHtml), "");
const serviceWorker = worker
  .replace("__WISP_OFFLINE_HTML__", () => JSON.stringify(offlineHtml))
  .replace("__WISP_OFFLINE_CSP__", () => JSON.stringify(offlinePolicy));
const icons: Record<string, string> = {
  "/icons/wisp-192.png": icon192,
  "/icons/wisp-512.png": icon512,
  "/apple-touch-icon.png": touchIcon,
};

/** A fixed allowlist embedded by Bun, never a filesystem/static-directory route. */
export function pwaResponse(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  const icon = Object.hasOwn(icons, path) ? icons[path] : undefined;
  if (!icon && path !== "/manifest.webmanifest" && path !== "/sw.js") return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const body = icon ? Bun.file(icon) : path === "/sw.js" ? serviceWorker : manifest;
  return new Response(request.method === "HEAD" ? null : body, { headers: {
    "Content-Type": icon ? "image/png" : path === "/sw.js" ? "text/javascript; charset=utf-8" : "application/manifest+json",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(path === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
  } });
}
