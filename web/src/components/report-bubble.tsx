import { CopyButton } from "@/components/copy-button"
import { Flowchart } from "@/components/icons"
import { BUBBLE_ACTION, BubbleTimestamp } from "@/components/person-bubble"
import { parseReportText } from "@/lib/report-text"

/**
 * The head of a turn a subtask report started. Wisp wrote that prompt, not
 * the person, so it never wears the person's right-aligned bubble: it sits
 * on the left, under Wisp's name, with Wisp's facts first and each child's
 * own words quoted below them, labelled as theirs.
 */
export function ReportBubble({ text, at }: { text: string; at: string }) {
  const { facts, quotes } = parseReportText(text)
  return (
    <div data-report-turn className="group/bubble relative rounded-xl rounded-bl-[4px] border border-dashed border-border px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-[10.5px] text-faint">
        <Flowchart aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-muted-foreground">Wisp</span>
        <span aria-hidden>·</span>
        <span>reports from subtasks</span>
        <span aria-hidden>·</span>
        <BubbleTimestamp at={at} />
        <span className="ml-auto pointer:opacity-0 pointer:group-hover/bubble:opacity-100 pointer:group-focus-within/bubble:opacity-100">
          <CopyButton text={text} label="Copy the reports" copiedLabel="Copied the reports" className={BUBBLE_ACTION} />
        </span>
      </div>
      <div className="mt-1.5 space-y-0.5 text-[12px] leading-relaxed text-fg-secondary">
        {facts.map((line, index) => (
          <p key={index} className="wrap-anywhere">{line}</p>
        ))}
      </div>
      {quotes.map((quote, index) => (
        <figure key={index} className="mt-2.5" data-report-quote>
          <figcaption className="text-[10.5px] text-faint">{quote.label} — its words, not Wisp&apos;s or yours</figcaption>
          <blockquote className="mt-1 border-l-2 border-border pl-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/90 wrap-anywhere">
            {quote.body}
          </blockquote>
        </figure>
      ))}
    </div>
  )
}
