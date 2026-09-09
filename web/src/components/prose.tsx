import type { ComponentProps } from "react"
import remarkBreaks from "remark-breaks"
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown"

import { externalLinkProps } from "@/lib/external-links"
import { PROSE_HIGHLIGHT_PLUGINS } from "@/lib/prose-highlight"
import { RemoteImage } from "./remote-image"
import { cn } from "@/lib/utils"
import { useWorktreeFileOpener, worktreeFilePath } from "@/lib/worktree-files"

/** Agent prose, rendered safely while markdown is still streaming. */
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-[13px] leading-[1.7] text-foreground/85", className)}>
      <Streamdown
        parseIncompleteMarkdown
        controls={false}
        remarkPlugins={PROSE_REMARK_PLUGINS}
        rehypePlugins={PROSE_REHYPE_PLUGINS}
        components={PROSE_COMPONENTS}
      >
        {text}
      </Streamdown>
    </div>
  )
}

const PROSE_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkBreaks]

/**
 * Streamdown's rehype chain without `harden`, which is the only reason a
 * repository path could not be a link.
 *
 * Its configured allow-lists are already `["*"]` for prefixes and protocols,
 * so the sole rule it contributes here is "the URL must resolve" — and a
 * relative path never does. Dropping it costs nothing else, and it does NOT
 * loosen what a scheme may be: `sanitize` stays, and it is what empties a
 * `javascript:` or `file:` href. `linkSafety` is a different mechanism and
 * blocks none of this; leaving it at its default is deliberate.
 */
const PROSE_REHYPE_PLUGINS = [
  ...Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "harden")
    .map(([, plugin]) => plugin),
  // LAST, and deliberately after `sanitize`: the `hljs-*` spans are added to a
  // tree that has already been sanitised, so they reach the DOM (§5b).
  ...PROSE_HIGHLIGHT_PLUGINS,
] as ComponentProps<typeof Streamdown>["rehypePlugins"]

const PROSE_COMPONENTS: ComponentProps<typeof Streamdown>["components"] = {
  p: ({ children }) => <p className="mt-2.5 first:mt-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  a: ({ children, href }) => <ProseLink href={href}>{children}</ProseLink>,

  img: ({ src, alt }) => <RemoteImage src={typeof src === "string" ? src : undefined} alt={alt} />,

  ul: ({ children }) => <ul className="mt-2.5 ml-4 list-outside list-disc space-y-1 marker:text-faint">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mt-2.5 ml-4 list-outside list-decimal space-y-1 marker:text-faint">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,

  h1: ({ children }) => <h1 className="mt-4 text-[14.5px] font-semibold tracking-[-0.01em] text-foreground">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 text-[13.5px] font-semibold text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3.5 text-[13px] font-semibold text-foreground">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-3 text-[12.5px] font-semibold text-fg-secondary">{children}</h4>,

  blockquote: ({ children }) => (
    <blockquote className="mt-2.5 border-l-2 border-border-strong pl-3 text-fg-secondary">{children}</blockquote>
  ),
  hr: () => <hr className="my-3.5 border-0 border-t border-border" />,

  table: ({ children }) => (
    <div className="scroll-slim mt-2.5 max-w-full overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 text-left text-[11px] font-semibold text-fg-secondary">{children}</th>
  ),
  td: ({ children }) => <td className="px-2.5 py-1.5 align-top text-foreground/85">{children}</td>,

  code: ({ children, className: lang }) => {
    if (lang) return <code className={cn(lang, "font-mono text-[11.5px]")}>{children}</code>
    return <code className="rounded bg-accent-wash px-1.5 py-px text-[12px] text-accent-soft">{children}</code>
  },
  // `bg-code`, never `bg-card`: the prompt bubble owns `--card`, and a code
  // block wearing the same fill made the two indistinguishable when scanning
  // a transcript for "where did I say something". This one recedes toward the
  // reading column so the bubble stays the brightest thing in the stream.
  pre: ({ children }) => (
    <pre
      className={cn(
        "scroll-slim mt-2.5 overflow-x-auto rounded-md border border-border bg-code px-3 py-2",
        "font-mono text-[11.5px] leading-[1.75]",
        // A fence's contents arrive as a `code` element and so does inline
        // code; the ONLY thing that tells them apart is the `language-*` class
        // markdown adds when — and only when — the fence names a language. A
        // bare ``` has none, so it took the inline branch above and wore the
        // violet chip: pill fill, side padding and accent text, wrapped round
        // a whole block, on top of this surface. Two code styles at once, and
        // a block-sized wash of the one hue §1 spends on inline code.
        //
        // The block is the parent, so the block decides. A fence is plain
        // mono on `--code` whether or not it named a language; naming one adds
        // colour INSIDE the text, and nothing else.
        "[&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[11.5px] [&>code]:text-inherit"
      )}
    >
      {children}
    </pre>
  ),
}

/** Prose's `a`, which resolves to one of the three things an href can be. */
const LINK_CLASS =
  "text-accent-soft underline decoration-accent-dim underline-offset-2 hover:text-primary hover:decoration-primary"

function ProseLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  // A hook, so this cannot be inlined into the component map above.
  const openFile = useWorktreeFileOpener()

  // A web address leaves the app. Desktop needs the click; the browser does not.
  const link = externalLinkProps(href)
  if (link) {
    return (
      <a {...link} className={LINK_CLASS}>
        {children}
      </a>
    )
  }

  /**
   * A repository path opens in the viewer — a button, because it goes nowhere:
   * an anchor would offer a context menu full of things that cannot work, and
   * a middle-click that navigates the shell away from itself.
   *
   * Whether the file is there is the daemon's answer, on click. Verifying every
   * path on render would cost a request per link per turn of a transcript
   * nobody has clicked yet.
   */
  const path = worktreeFilePath(href)
  if (path && openFile) {
    return (
      <button
        type="button"
        onClick={() => openFile(path)}
        title={path}
        className={cn(LINK_CLASS, "cursor-pointer text-left focus-visible:outline-none")}
      >
        {children}
      </button>
    )
  }

  // No worktree behind this prose, or an href `sanitize` already emptied.
  return <>{children}</>
}
