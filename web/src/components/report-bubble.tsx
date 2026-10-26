import { CopyButton } from "@/components/copy-button"
import { Flowchart } from "@/components/icons"
import { BUBBLE_ACTION } from "@/components/person-bubble"
import { SystemFrame } from "@/components/system-turn"
import { parseReportText } from "@/lib/report-text"

const REPORT_LABEL = { who: "Wisp", parts: ["reports from subtasks"] }

/**
 * The head of a turn a subtask report started. Wisp wrote that prompt, not
 * the person, so it wears the system frame (system-turn.tsx): Wisp's facts
 * first, and each child's own words quoted below them, labelled as theirs.
 */
export function ReportBubble({ text, at }: { text: string; at: string }) {
  const { facts, quotes } = parseReportText(text)
  return (
    <SystemFrame
      icon={Flowchart}
      label={REPORT_LABEL}
      at={at}
      data={{ "data-report-turn": "" }}
      copy={<CopyButton text={text} label="Copy the reports" copiedLabel="Copied the reports" className={BUBBLE_ACTION} />}
    >
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
    </SystemFrame>
  )
}
