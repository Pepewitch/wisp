#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

interface BrokenLink {
  destination: string;
  file: string;
  line: number;
  reason: string;
}

interface LocalDestination {
  anchor?: string;
  path: string;
}

const MARKDOWN_LINK = /!?\[[^\]]*]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g;
const EXTERNAL_DESTINATION = /^(?:[a-z][a-z0-9+.-]*:|\/)/i;

function trackedMarkdownFiles(root: string): string[] {
  return execFileSync("git", ["-C", root, "ls-files", "-z", "--", "*.md"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function localDestination(destination: string): LocalDestination | undefined {
  const unwrapped = destination.startsWith("<") && destination.endsWith(">")
    ? destination.slice(1, -1)
    : destination;
  if (EXTERNAL_DESTINATION.test(unwrapped)) return undefined;
  const [pathAndQuery, fragment] = unwrapped.split("#", 2);
  return {
    anchor: fragment ? decodeURIComponent(fragment) : undefined,
    path: decodeURIComponent(pathAndQuery.split("?", 1)[0]),
  };
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function markdownAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const duplicates = new Map<string, number>();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = headingSlug(match[1]);
    const duplicate = duplicates.get(base) ?? 0;
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`);
    duplicates.set(base, duplicate + 1);
  }
  return anchors;
}

export function findBrokenMarkdownLinks(
  root: string,
  files = trackedMarkdownFiles(root),
): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const anchorCache = new Map<string, Set<string>>();
  for (const file of files) {
    const absoluteFile = resolve(root, file);
    const source = readFileSync(absoluteFile, "utf8");
    for (const match of source.matchAll(MARKDOWN_LINK)) {
      const destination = match[1];
      let local: LocalDestination | undefined;
      try {
        local = localDestination(destination);
      } catch {
        broken.push({
          destination,
          file,
          line: lineNumber(source, match.index),
          reason: "invalid URL encoding",
        });
        continue;
      }
      if (!local) continue;

      const target = local.path ? resolve(dirname(absoluteFile), local.path) : absoluteFile;
      const projectRelative = relative(root, target);
      const outsideRoot =
        projectRelative === ".." ||
        projectRelative.startsWith(`..${sep}`) ||
        isAbsolute(projectRelative);
      if (outsideRoot || !existsSync(target)) {
        broken.push({
          destination,
          file,
          line: lineNumber(source, match.index),
          reason: outsideRoot ? "target is outside the repository" : "target does not exist",
        });
        continue;
      }

      if (local.anchor && extname(target).toLowerCase() === ".md") {
        let anchors = anchorCache.get(target);
        if (!anchors) {
          anchors = markdownAnchors(readFileSync(target, "utf8"));
          anchorCache.set(target, anchors);
        }
        if (!anchors.has(local.anchor)) {
          broken.push({
            destination,
            file,
            line: lineNumber(source, match.index),
            reason: "heading anchor does not exist",
          });
        }
      }
    }
  }
  return broken;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const files = trackedMarkdownFiles(root);
  const broken = findBrokenMarkdownLinks(root, files);
  if (broken.length > 0) {
    for (const link of broken) {
      console.error(`${link.file}:${link.line}: ${link.destination} (${link.reason})`);
    }
    process.exit(1);
  }
  console.log(`checked ${files.length} tracked Markdown files`);
}
