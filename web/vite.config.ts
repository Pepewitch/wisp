import path from "path"
import { readFileSync } from "fs"
import { homedir } from "os"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { inlineBuildAssets } from "./scripts/inline-build-assets.ts"
import { defineConfig } from "vitest/config"

/**
 * The dev server proxies /api (WebSocket included) to a running Wisp daemon. The
 * daemon port comes from the same config.json the daemon reads (WISP_HOME
 * override honored). The contributor default is ~/.wisp-dev:18710, never the
 * installed service's ~/.wisp.
 */
function daemonTarget(): string {
  const wispHome = process.env.WISP_HOME ?? path.join(homedir(), ".wisp-dev")
  try {
    const cfg = JSON.parse(
      readFileSync(path.join(wispHome, "config.json"), "utf8")
    ) as { port?: unknown }
    if (typeof cfg.port === "number") return `http://127.0.0.1:${cfg.port}`
  } catch {
    // no config yet — dev:init normally creates it before Vite starts
  }
  return "http://127.0.0.1:18710"
}

export default defineConfig(({ command, mode }) => {
  // Desktop keeps the self-contained artifact. The daemon's web build keeps
  // CSS and fonts inline, but serves the entry and Mermaid's dynamic imports
  // from a fixed, generated asset allowlist. Some lazy chunks import shared
  // symbols from the entry, so it must remain a real URL.
  const webBuild = command === "build" && mode === "web"

  return {
    plugins: [
      react(),
      tailwindcss(),
      inlineBuildAssets(webBuild),
    ],
    // the daemon serves the built file at / — relative asset URLs keep the
    // singlefile honest even for anything that cannot be inlined
    base: "./",
    build: {
      outDir: webBuild ? "./web-dist" : "./ui-dist",
      emptyOutDir: true,
      ...(webBuild
        ? {
            // The plugin inlines CSS; keep the entry and dynamic imports split.
            // Fonts and favicon remain in the initial HTML/CSS as data URLs.
            manifest: true,
            cssCodeSplit: false,
            assetsInlineLimit: () => true,
            assetsDir: "chunks",
          }
        : {
            assetsInlineLimit: () => true,
            cssCodeSplit: false,
            assetsDir: "",
            chunkSizeWarningLimit: 100_000_000,
            rolldownOptions: { output: { codeSplitting: false } },
          }),
    },
    server: {
      proxy: {
        "/api": { target: daemonTarget(), ws: true },
        "/manifest.webmanifest": { target: daemonTarget() },
        "/apple-touch-icon.png": { target: daemonTarget() },
        "/icons/": { target: daemonTarget() },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    test: {
      environment: "jsdom",
      // Node 25+ enables its process-global Web Storage by default. Disable it
      // when supported so it cannot shadow jsdom's isolated browser storage.
      execArgv:
        Number.parseInt(process.versions.node, 10) >= 25
          ? ["--no-webstorage"]
          : [],
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }
})
