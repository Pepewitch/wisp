import type { Plugin } from "vite"

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Only generated entry tags are rewritten; no glob language or external assets. */
export function inlineBuildAsset(html: string, filename: string, source: string, kind: "script" | "style"): string {
  const name = escaped(filename)
  if (kind === "style") {
    const tag = new RegExp(`<link([^>]*?) href="(?:\\./)?${name}"([^>]*)>`, "g")
    const css = source.replace(/^@charset ["']UTF-8["'];\s*/i, "").replace(/<\/style/gi, "\\3c /style")
    return html.replace(tag, (_tag, before: string, after: string) => `<style${before}${after}>${css}</style>`)
  }
  const tag = new RegExp(`<script([^>]*?) src="(?:\\./)?${name}"([^>]*)></script>`, "g")
  // Preserve JS string values without letting embedded HTML close the script.
  const code = source.replace(/"?__VITE_PRELOAD__"?/g, "void 0").replace(/<(\/script|!--)/gi, "\\x3C$1")
  return html.replace(tag, (_tag, before: string, after: string) => `<script${before}${after}>${code}</script>`)
}

/** Wisp has two fixed layouts: Desktop inlines its entry JS; Browser keeps chunks. */
export function inlineBuildAssets(webBuild: boolean): Plugin {
  return {
    name: "wisp:inline-build-assets",
    enforce: "post",
    generateBundle(_options, bundle) {
      const removed = new Set<string>()
      for (const html of Object.values(bundle)) {
        if (html.type !== "asset" || !html.fileName.endsWith(".html")) continue
        let source = typeof html.source === "string" ? html.source : new TextDecoder().decode(html.source)
        for (const asset of Object.values(bundle)) {
          const kind = asset.type === "chunk" && !webBuild ? "script"
            : asset.type === "asset" && asset.fileName.endsWith(".css") ? "style" : null
          if (!kind) continue
          const content = asset.type === "chunk" ? asset.code
            : typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source)
          const replaced = inlineBuildAsset(source, asset.fileName, content, kind)
          if (replaced !== source) removed.add(asset.fileName)
          source = replaced
        }
        html.source = source
      }
      for (const filename of removed) delete bundle[filename]
    },
  }
}
