/**
 * Bytes the two shipped UIs cost before anything renders: the browser bundle's
 * entry chunk and what it statically imports (gzip, as served), its HTML, and
 * the Desktop app's single-file bundle. Read from `bun run build:all-ui`'s
 * output, which `bun run bench` builds first.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Measurement } from "./shared";

const WEB = join(import.meta.dir, "..", "web");

interface ManifestEntry {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

function built(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing: run \`bun run build:all-ui\` first`);
  return path;
}

export function bundleMeasurements(): Measurement[] {
  const dist = join(WEB, "web-dist");
  const manifest = JSON.parse(readFileSync(built(join(dist, ".vite", "manifest.json")), "utf8")) as Record<string, ManifestEntry>;
  const entries = Object.keys(manifest).filter((key) => manifest[key]!.isEntry);
  if (entries.length !== 1) throw new Error(`expected one entry in the web manifest, found ${entries.length}`);
  // Everything the page loads before its first render: the entry and its
  // static imports, transitively. Lazy chunks (Mermaid, highlighters) are not.
  const initial = new Set<string>();
  const visit = (key: string): void => {
    const entry = manifest[key];
    if (!entry || initial.has(entry.file)) return;
    initial.add(entry.file);
    for (const next of entry.imports ?? []) visit(next);
  };
  visit(entries[0]!);
  const gzip = [...initial].reduce((sum, file) => sum + Bun.gzipSync(readFileSync(join(dist, file))).length, 0);
  return [
    { name: "bundle.webInitialJs.gzipBytes", value: gzip, unit: "bytes", detail: [...initial].join(", ") },
    { name: "bundle.webIndexHtml.bytes", value: statSync(join(dist, "index.html")).size, unit: "bytes" },
    { name: "bundle.desktopIndexHtml.bytes", value: statSync(built(join(WEB, "ui-dist", "index.html"))).size, unit: "bytes" },
  ];
}
