/** What the real-browser security check needs to know about the built web chunks. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

function webManifest(): Record<string, ManifestChunk> {
  return JSON.parse(readFileSync(join(import.meta.dir, "../web/web-dist/.vite/manifest.json"), "utf8")) as
    Record<string, ManifestChunk>;
}

/** The entry and the chunks it imports statically: what every page may load before it renders. */
export function initialChunkPaths(): Set<string> {
  const manifest = webManifest();
  const initial = new Set<string>();
  const visit = (key: string): void => {
    const chunk = manifest[key];
    if (!chunk || initial.has(`/${chunk.file}`)) return;
    initial.add(`/${chunk.file}`);
    for (const next of chunk.imports ?? []) visit(next);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
  return initial;
}

export function mermaidChunkPath(): string {
  const entries = Object.entries(webManifest()).filter(([source, entry]) =>
    source.includes("@streamdown/mermaid/dist/index.js") && entry.isDynamicEntry);
  if (entries.length !== 1 || !/^chunks\/[a-zA-Z0-9_-]+\.js$/.test(entries[0]![1].file)) {
    throw new Error(`expected one hashed Mermaid entry chunk, got ${JSON.stringify(entries)}`);
  }
  return `/${entries[0]![1].file}`;
}
