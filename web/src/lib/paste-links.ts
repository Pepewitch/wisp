import type { ClipboardEvent } from "react";

/**
 * Composer paste: images still win (the attachment hook preventDefaults those).
 * A text paste with HTML hyperlinks is rewritten to markdown `[label](url)` so
 * a Slack list of PR links keeps the URLs a textarea would otherwise drop.
 * Bold and the rest of the HTML are ignored — only http(s) anchors are special.
 */

const BLOCK = new Set([
  "P",
  "DIV",
  "LI",
  "TR",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "TABLE",
  "THEAD",
  "TBODY",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
]);

/** Absolute http(s) only — never resolve a relative href against the Wisp origin. */
export function safeHttpUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
}

function escapeLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function formatHref(href: string): string {
  return /[\s()]/.test(href) ? `<${href}>` : href;
}

function formatLink(text: string, href: string): string {
  const label = text.replace(/\s+/g, " ").trim();
  if (!label || label === href) return href;
  return `[${escapeLabel(label)}](${formatHref(href)})`;
}

function walk(node: Node, olIndex?: { n: number }): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.nodeValue ?? "";
    if (/^\s*$/.test(raw)) return raw.includes("\n") ? "" : raw.length > 0 ? " " : "";
    return raw;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName;

  if (tag === "BR") return "\n";
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "HEAD" || tag === "META") return "";

  if (tag === "A") {
    const inner = [...el.childNodes].map((child) => walk(child)).join("");
    const url = safeHttpUrl(el.getAttribute("href"));
    if (!url) return inner;
    return formatLink(inner, url);
  }

  if (tag === "OL") {
    const idx = { n: 1 };
    return [...el.children]
      .filter((child) => child.tagName === "LI")
      .map((child) => walk(child, idx))
      .join("");
  }

  if (tag === "LI") {
    const inner = [...el.childNodes].map((child) => walk(child)).join("").trim();
    if (olIndex) {
      const n = olIndex.n++;
      return `${n}. ${inner}\n`;
    }
    return `${inner}\n`;
  }

  const inner = [...el.childNodes].map((child) => walk(child, olIndex)).join("");
  if (BLOCK.has(tag)) return `${inner.replace(/\n+$/, "")}\n`;
  return inner;
}

/**
 * Rewrite clipboard HTML so each http(s) `<a href>` becomes markdown.
 * Returns null when there is nothing to rewrite, so the caller can leave the
 * browser's default `text/plain` paste alone.
 */
export function markdownFromHtmlLinks(html: string): string | null {
  if (!html.trim()) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const hasLink = [...doc.querySelectorAll("a[href]")].some((a) => safeHttpUrl(a.getAttribute("href")));
  if (!hasLink) return null;
  const text = walk(doc.body)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/**
 * Image files still go to `onImagePaste`. HTML with http(s) links is inserted
 * as markdown at the caret. Anything else falls through to the textarea default.
 */
export function handleComposerPaste(
  e: ClipboardEvent<HTMLTextAreaElement>,
  {
    onImagePaste,
    value,
    onChange,
  }: {
    onImagePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
    value: string;
    onChange: (next: string, caret: number) => void;
  },
): void {
  onImagePaste(e);
  if (e.defaultPrevented) return;
  const html = e.clipboardData?.getData?.("text/html") ?? "";
  const rewritten = markdownFromHtmlLinks(html);
  if (rewritten == null) return;
  e.preventDefault();
  const el = e.currentTarget;
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const next = value.slice(0, start) + rewritten + value.slice(end);
  const caret = start + rewritten.length;
  onChange(next, caret);
  const restore = () => {
    el.selectionStart = el.selectionEnd = caret;
  };
  queueMicrotask(restore);
  requestAnimationFrame(restore);
}
