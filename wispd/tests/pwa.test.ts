import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { pwaResponse } from "../src/pwa";
import { contentSecurityPolicy, pageSecurityPolicy } from "../src/routes/security-headers";

const origin = "https://wisp.example";
const get = (path: string, method = "GET") => pwaResponse(new Request(origin + path, { method }));

describe("embedded PWA resources", () => {
  test("manifest has a stable root identity and real mask-safe PNG icons", async () => {
    const response = get("/manifest.webmanifest")!;
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    const manifest = await response.json();
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone" });
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of [...manifest.icons, { src: "/apple-touch-icon.png", sizes: "180x180" }]) {
      const res = get(icon.src)!;
      expect(res.headers.get("content-type")).toBe("image/png");
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });

  test("fixed assets support HEAD and reject writes and arbitrary paths", async () => {
    for (const path of ["/sw.js", "/manifest.webmanifest", "/icons/wisp-512.png", "/apple-touch-icon.png"]) {
      expect(await get(path, "HEAD")!.text()).toBe("");
      expect(get(path, "POST")!.status).toBe(405);
      expect(get(path)!.headers.get("x-content-type-options")).toBe("nosniff");
      expect(get(path)!.headers.get("cache-control")).toBe("no-cache");
    }
    for (const path of ["/icons/unknown.png", "/brand/og.png", "/api/tasks", "/offline.html", "/constructor"]) expect(get(path)).toBeNull();
    expect(get("/sw.js")!.headers.get("service-worker-allowed")).toBe("/");
  });
});

async function worker(fetchImpl: (request: Request, options?: RequestInit) => Promise<Response>, fastTimeout = false) {
  const handlers = new Map<string, (event: unknown) => void>();
  const source = await get("/sw.js")!.text();
  // Deliberately no Cache Storage in the environment: runtime state must never
  // be persisted by this worker, including authenticated navigation responses.
  runInNewContext(source, {
    self: { location: { origin }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) },
    URL, Response, AbortController,
    setTimeout: fastTimeout ? (callback: () => void) => setTimeout(callback, 10) : setTimeout,
    clearTimeout, fetch: fetchImpl,
  });
  return (path: string, mode = "navigate", method = "GET") => {
    let answer: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: { url: new URL(path, origin).href, mode, method }, respondWith: (response: Promise<Response>) => { answer = response; } });
    return answer;
  };
}

describe("PWA navigation recovery", () => {
  test("a stalled tailnet navigation is aborted and replaced with recovery", async () => {
    let aborted = false;
    const navigate = await worker((_request, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("timeout")); });
    }), true);
    expect((await navigate("/"))!.status).toBe(503);
    expect(aborted).toBe(true);
  });

  test("API, assets, writes and external requests bypass the worker", async () => {
    const navigate = await worker(() => { throw new Error("must not fetch"); });
    expect(navigate("/api/tasks")).toBeUndefined();
    expect(navigate("/api/tasks/example/attachments/file")).toBeUndefined();
    expect(navigate("/", "cors")).toBeUndefined();
    expect(navigate("/", "navigate", "POST")).toBeUndefined();
    expect(navigate("https://other.example/")).toBeUndefined();
  });

  test("uses the live daemon response every time and preserves authentication refusals", async () => {
    let calls = 0;
    const navigate = await worker(async () => new Response(String(++calls), { status: calls === 3 ? 401 : 200 }));
    expect(await (await navigate("/"))!.text()).toBe("1");
    expect(await (await navigate("/index.html"))!.text()).toBe("2");
    expect((await navigate("/"))!.status).toBe(401);
  });

  test.each(["network", "proxy"])("%s failure returns self-contained recovery under a matching CSP", async (failure) => {
    const navigate = await worker(async () => {
      if (failure === "network") throw new TypeError("offline");
      return new Response("unavailable", { status: 502 });
    });
    const response = (await navigate("/"))!;
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Let’s get you reconnected");
    expect(html).toContain("Tailscale");
    expect(html).not.toMatch(/__WISP_|<script[^>]+src=/);
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy(pageSecurityPolicy(html), ""));
  });
});
