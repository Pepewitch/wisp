import path from "path"
import { readFileSync } from "fs"
import { homedir } from "os"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { viteSingleFile } from "vite-plugin-singlefile"
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
    const cfg = JSON.parse(readFileSync(path.join(wispHome, "config.json"), "utf8")) as { port?: unknown }
    if (typeof cfg.port === "number") return `http://127.0.0.1:${cfg.port}`
  } catch {
    // no config yet — dev:init normally creates it before Vite starts
  }
  return "http://127.0.0.1:18710"
}

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  // the daemon serves the built file at / — relative asset URLs keep the
  // singlefile honest even for anything that cannot be inlined
  base: "./",
  build: {
    // committed bundle: the daemon text-imports web/ui-dist/index.html and
    // serves exactly that one file, with no asset routes behind it
    outDir: "../ui-dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": { target: daemonTarget(), ws: true },
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
    execArgv: Number.parseInt(process.versions.node, 10) >= 25 ? ["--no-webstorage"] : [],
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
