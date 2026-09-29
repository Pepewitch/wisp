#!/usr/bin/env bun
import { createHash } from "node:crypto"
import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { gzipSync } from "node:zlib"
import ts from "typescript"

// Bun's compiled binary only embeds assets named by literal imports. Build a
// source module and exact allowlist from Vite's output, then compile that module
// into the daemon. Neither the daemon nor an installed binary reads a sibling
// directory at runtime.
const dist = path.resolve(import.meta.dirname, "../web-dist")
const chunks = path.join(dist, "chunks")
const index = path.join(dist, "index.html")
const viteManifest = path.join(dist, ".vite/manifest.json")

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function assertBuildShape(): string[] {
  const topLevel = readdirSync(dist).sort()
  if (
    JSON.stringify(topLevel) !==
    JSON.stringify([".vite", "chunks", "index.html"])
  ) {
    throw new Error(`unexpected web build entries: ${topLevel.join(", ")}`)
  }
  const viteEntries = readdirSync(path.join(dist, ".vite"))
  if (viteEntries.length !== 1 || viteEntries[0] !== "manifest.json") {
    throw new Error(
      `unexpected Vite manifest entries: ${viteEntries.join(", ")}`
    )
  }
  JSON.parse(readFileSync(viteManifest, "utf8"))

  const html = readFileSync(index, "utf8")
  if (!html.includes("<style")) {
    throw new Error("web entry CSS was not inlined into index.html")
  }
  if (/<link\b[^>]*rel="stylesheet"/i.test(html)) {
    throw new Error("web entry references an external stylesheet")
  }

  const files = readdirSync(chunks).sort()
  if (
    files.length === 0 ||
    files.some((file) => !/^[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.js$/.test(file))
  ) {
    throw new Error(
      "web build contains missing, unhashed, or unsupported chunks"
    )
  }
  if (!files.some((file) => file.startsWith("mermaid-"))) {
    throw new Error("Mermaid was not split from the web entry")
  }
  const entryFiles = files.filter((file) =>
    /^index-[A-Za-z0-9_-]{8}\.js$/.test(file)
  )
  if (entryFiles.length !== 1) {
    throw new Error(
      `expected one external web entry, found ${entryFiles.length}`
    )
  }
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map(
    (match) => match[1]
  )
  if (scripts.length !== 1 || scripts[0] !== `./chunks/${entryFiles[0]}`) {
    throw new Error(
      `web HTML does not load the allowlisted entry: ${scripts.join(", ")}`
    )
  }
  for (const [, url] of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) {
    if (
      !url.startsWith("./chunks/") ||
      !files.includes(url.slice("./chunks/".length))
    ) {
      throw new Error(
        `web HTML references a missing or unapproved script: ${url}`
      )
    }
  }
  return files
}

const files = assertBuildShape()
const fileSet = new Set(files)
const staticImports = new Map<string, string[]>()
const dynamicImports = new Map<string, string[]>()
const sources = new Map<string, string>()
for (const file of files) {
  const code = readFileSync(path.join(chunks, file), "utf8")
  sources.set(file, code)
  // Also catch Vite's preload URL strings, not just ESM import declarations.
  for (const [, relative] of code.matchAll(/\.\/([A-Za-z0-9._/-]+\.js)/g)) {
    const dependency = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), relative)
    )
    if (!fileSet.has(dependency)) {
      throw new Error(`web chunk ${file} references missing ${dependency}`)
    }
  }

  const statics: string[] = []
  const dynamics: string[] = []
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  const append = (specifier: ts.Expression | undefined, to: string[]) => {
    if (
      !specifier ||
      !ts.isStringLiteralLike(specifier) ||
      !specifier.text.startsWith("./")
    )
      return
    const dependency = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier.text)
    )
    if (!fileSet.has(dependency)) {
      throw new Error(`web chunk ${file} imports missing ${dependency}`)
    }
    to.push(dependency)
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      append(node.moduleSpecifier, statics)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      append(node.arguments[0], dynamics)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  staticImports.set(file, statics)
  dynamicImports.set(file, dynamics)
}

const entry = files.find((file) => file.startsWith("index-"))!
const mermaid = files.find((file) => file.startsWith("mermaid-"))!
const manifest = JSON.parse(readFileSync(viteManifest, "utf8")) as Record<
  string,
  { file: string; isDynamicEntry?: boolean }
>
const mermaidPackage = Object.entries(manifest).find(([source]) =>
  source.includes("/@streamdown/mermaid/")
)
if (!mermaidPackage?.[1].isDynamicEntry) {
  throw new Error("Mermaid package is not a dynamic Vite entry")
}
const mermaidPackageFile = mermaidPackage[1].file.replace(/^chunks\//, "")
const staticClosure = new Set<string>()
const queue = [entry]
while (queue.length > 0) {
  const file = queue.pop()!
  if (staticClosure.has(file)) continue
  staticClosure.add(file)
  queue.push(...(staticImports.get(file) ?? []))
}
// What the page loads up front may ask for these later. Shared modules can
// land in chunks the entry imports, so the import need not be in the entry.
const lazyImports = new Set(
  [...staticClosure].flatMap((file) => dynamicImports.get(file) ?? [])
)
function assertLazy(label: string, file: string): void {
  if (staticClosure.has(file) || !lazyImports.has(file)) {
    throw new Error(
      `${label} must remain a lazy import outside the web entry's static graph`
    )
  }
}
assertLazy("Mermaid", mermaid)
assertLazy("Mermaid", mermaidPackageFile)

// The other code only some pages need. A marker is a string the library's
// own code always carries, so it also catches the library slipping into a
// static chunk by another import path; it must be found somewhere, or the
// check would pass by matching nothing.
const LAZY_SOURCES: { label: string; source: string; marker?: string }[] = [
  {
    label: "The terminal (xterm)",
    source: "src/components/shell-view.tsx",
    marker: "xterm-helper-textarea",
  },
  {
    label: "The syntax highlighter (highlight.js)",
    source: "/rehype-highlight/index.js",
    marker: "Falling back to no-highlight mode",
  },
  { label: "The design gallery", source: "src/components/gallery.tsx" },
]
for (const lazy of LAZY_SOURCES) {
  const found = Object.entries(manifest).find(
    ([source, chunk]) =>
      (source === lazy.source || source.endsWith(lazy.source)) &&
      chunk.isDynamicEntry
  )
  if (!found) throw new Error(`${lazy.label} is not a dynamic Vite entry`)
  assertLazy(lazy.label, found[1].file.replace(/^chunks\//, ""))
  if (!lazy.marker) continue
  const holders = files.filter((file) => sources.get(file)!.includes(lazy.marker!))
  if (holders.length === 0) {
    throw new Error(`${lazy.label}: no chunk contains "${lazy.marker}"; update the marker`)
  }
  const eager = holders.filter((file) => staticClosure.has(file))
  if (eager.length > 0) {
    throw new Error(
      `${lazy.label} is in the web entry's static graph: ${eager.join(", ")}`
    )
  }
}

const assets = files.map((file) => {
  const bytes = readFileSync(path.join(chunks, file))
  const compressed = gzipSync(bytes, { level: 9 })
  writeFileSync(path.join(chunks, `${file}.gz`), compressed)
  return {
    path: `/chunks/${file}`,
    sha256: sha256(bytes),
    gzipSha256: sha256(compressed),
  }
})

writeFileSync(
  path.join(dist, "asset-manifest.json"),
  `${JSON.stringify({ version: 1, assets }, null, 2)}\n`
)

const imports = files.flatMap((file, i) => [
  `import chunk${i} from "./chunks/${file}" with { type: "file" }`,
  `import gzip${i} from "./chunks/${file}.gz" with { type: "file" }`,
])
const maps = (prefix: string) =>
  files.map((file, i) => `  "/chunks/${file}": ${prefix}${i},`).join("\n")
writeFileSync(
  path.join(dist, "embedded-assets.ts"),
  [
    "// Generated by web/scripts/generate-web-assets.ts; never edit or commit.",
    ...imports,
    "",
    "export const embeddedWebAssets: Record<string, string> = {",
    maps("chunk"),
    "}",
    "",
    "export const embeddedWebCompressedAssets: Record<string, string> = {",
    maps("gzip"),
    "}",
    "",
  ].join("\n")
)

console.log(
  `web build: 1 entry and ${files.length - 1} split JS assets embedded (${(readFileSync(index).length / 1024).toFixed(0)} KiB HTML)`
)
