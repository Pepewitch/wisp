import type { ComponentProps } from "react"
import remarkBreaks from "remark-breaks"
import { defaultRemarkPlugins, Streamdown } from "streamdown"

import { cn } from "@/lib/utils"

/** Agent prose, rendered safely while markdown is still streaming. */
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("text-[13px] leading-[1.7] text-foreground/85", className)}>
      <Streamdown
        parseIncompleteMarkdown
        controls={false}
        remarkPlugins={PROSE_REMARK_PLUGINS}
        components={PROSE_COMPONENTS}
      >
        {text}
      </Streamdown>
    </div>
  )
}

const PROSE_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkBreaks]

const PROSE_COMPONENTS: ComponentProps<typeof Streamdown>["components"] = {
  p: ({ children }) => <p className="mt-2.5 first:mt-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent-soft underline decoration-accent-dim underline-offset-2 hover:text-primary hover:decoration-primary"
    >
      {children}
    </a>
  ),

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
  pre: ({ children }) => (
    <pre className="scroll-slim mt-2.5 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 font-mono text-[11.5px] leading-[1.75]">
      {children}
    </pre>
  ),
}
