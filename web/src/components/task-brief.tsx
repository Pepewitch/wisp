import { useId, useState, type ReactNode } from "react"

import { Check, ChevronRight } from "@/components/icons"
import { Rule, SwitchTrack } from "@/components/primitives"
import { Prose } from "@/components/prose"
import { recommendedOption, type BriefBandModel, type BriefInputView, type TaskBriefV1 } from "@/lib/brief"
import { cn } from "@/lib/utils"

/** Hand some words to find-in-task, in the turn they belong to. */
export type Reveal = (query: string, turn: number | null) => void

export interface BriefSectionProps {
  /** a live task on a daemon with briefs; an archived one keeps its report and loses the switch */
  switchable: boolean
  enabled: boolean
  disabled: boolean
  /** what switching does, or why it cannot; null once a report or its empty line says it */
  note: string | null
  error: string | null
  model: BriefBandModel
  /** per task: nothing opened on one task's brief carries to another's */
  reportKey: string
  touch?: boolean
  onChange: (enabled: boolean) => void
  onReveal?: Reveal
  onRetry?: () => void
}

/**
 * The task brief: the FIRST section of the Autopilot tab (frontend reference
 * §5k). The header says which task this is; this says where it stands — your
 * latest words as Wisp recorded them, then the agent's own report of goal,
 * result, what remains, and any decision waiting on you.
 *
 * It is the part of the tab a person reads, so nothing sits above it but the
 * tab strip, and nothing caps it: a long report is shown in full, and the
 * Automation section under it docks its header instead (autopilot-pane.tsx).
 *
 * The header row's switch is the one control here: it decides whether briefs
 * are generated, and is the same switch as the task menu's. Everything else
 * is READING ONLY and writes nothing.
 */
export function BriefSection({
  switchable,
  enabled,
  disabled,
  note,
  error,
  model,
  reportKey,
  touch = false,
  onChange,
  onReveal,
  onRetry,
}: BriefSectionProps) {
  const line = error ?? (switchable ? note : null)
  return (
    <section aria-label="Task brief">
      <BriefSwitch switchable={switchable} enabled={enabled} disabled={disabled} touch={touch} onChange={onChange} />
      {line && <p className="px-3.5 pt-0.5 pb-4 text-[11.5px] leading-relaxed text-muted-foreground">{line}</p>}
      {model.kind !== "hidden" && (
        <div className="pb-2">
          <BriefBody key={reportKey} model={model} touch={touch} onReveal={onReveal} onRetry={onRetry} />
        </div>
      )}
    </section>
  )
}

/**
 * The section's header row, which IS its switch: the whole row is the hit
 * target. An archived task keeps the header and loses the switch.
 */
export function BriefSwitch({
  switchable,
  enabled,
  disabled,
  touch,
  onChange,
}: {
  switchable: boolean
  enabled: boolean
  disabled: boolean
  touch: boolean
  onChange: (enabled: boolean) => void
}) {
  const row = cn("flex w-full items-center justify-between gap-3 px-3.5", touch ? "min-h-12" : "h-10")
  const label = <span className="text-[12.5px] font-semibold text-foreground">Brief</span>
  if (!switchable) return <div className={row}>{label}</div>
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Task brief"
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className={cn(
        row,
        "text-left transition-colors hover:bg-hover",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset disabled:opacity-60",
      )}
    >
      {label}
      <SwitchTrack checked={enabled} />
    </button>
  )
}

/** The report itself, from a model alone — which is also how the gallery draws it. */
export function BriefBody({
  model,
  touch = false,
  onReveal,
  onRetry,
}: {
  model: Exclude<BriefBandModel, { kind: "hidden" }>
  touch?: boolean
  onReveal?: Reveal
  onRetry?: () => void
}) {
  if (model.kind === "line") {
    return (
      <div className="flex items-center gap-2 px-3.5 py-3">
        <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">{model.text}</span>
        {model.retry && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={cn("shrink-0 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground", touch && "min-h-11")}
          >
            Retry
          </button>
        )}
      </div>
    )
  }
  return (
    // a new report (another turn or revision) starts with its comparison closed
    <div key={model.key} className="flex flex-col gap-2.5 px-3.5 py-3">
      <StatusFacts parts={model.status} />
      {model.input && <InputRow key={model.input.key} input={model.input} touch={touch} onReveal={onReveal} />}
      <div className="flex items-center gap-3 pt-0.5">
        <span className="shrink-0 text-[10.5px] text-faint">{model.divider}</span>
        <Rule />
      </div>
      <ReportRows brief={model.brief} touch={touch} originalRequest={model.originalRequest} onReveal={onReveal} />
    </div>
  )
}

/** One muted freshness line: which turn the report is from, and the one fact about how current it is. */
function StatusFacts({ parts }: { parts: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-faint">·</span>}
          {part}
        </span>
      ))}
    </div>
  )
}

function Row({ label, children, touch }: { label: string; children: ReactNode; touch: boolean }) {
  return (
    <div className={cn("grid gap-x-3 gap-y-0.5", !touch && "@min-[520px]:grid-cols-[76px_minmax(0,1fr)]")}>
      <div className="pt-[3px] text-[11.5px] text-muted-foreground">{label}</div>
      <div className="min-w-0 text-[13px] leading-[1.7] text-foreground">{children}</div>
    </div>
  )
}

/** Agent text: rendered by the app's one safe prose path, never as HTML. */
function AgentText({ text, className }: { text: string; className?: string }) {
  return <Prose text={text} mode="static" className={cn("text-[13px] leading-[1.7] text-foreground [&_p]:my-0", className)} />
}

function QuietButton({ children, onClick, touch }: { children: ReactNode; onClick: () => void; touch: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm text-[11.5px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline",
        touch && "min-h-11",
      )}
    >
      {children}
    </button>
  )
}

/** A caption item and the separator before it, kept together so a wrapped caption never ends on a dot. */
function CaptionItem({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      {!first && <span className="text-faint">·</span>}
      {children}
    </span>
  )
}

/** The person's own words — exact, cut only where the brief says it is cut. */
function InputRow({ input, touch, onReveal }: { input: BriefInputView; touch: boolean; onReveal?: Reveal }) {
  const [full, setFull] = useState(false)
  const long = [...input.text].length > 220
  const shown = full || !long ? input.text : `${[...input.text].slice(0, 200).join("").trimEnd()}`
  const cut = (long && !full) || input.truncated
  return (
    <Row label={input.label} touch={touch}>
      {input.question && <div className="text-[12.5px] text-muted-foreground">{input.question}</div>}
      <div className="whitespace-pre-wrap text-fg-secondary">
        “{shown}{cut ? "…" : ""}”
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
        {input.caption.map((part, i) => <CaptionItem key={i} first={i === 0}>{part}</CaptionItem>)}
        {long && !full && (
          <CaptionItem first={false}>
            <QuietButton touch={touch} onClick={() => setFull(true)}>Show all</QuietButton>
          </CaptionItem>
        )}
        {onReveal && input.find.query && (
          <CaptionItem first={false}>
            <QuietButton touch={touch} onClick={() => onReveal(input.find.query, input.find.turn)}>Show in conversation</QuietButton>
          </CaptionItem>
        )}
      </div>
    </Row>
  )
}

function ReportRows({
  brief,
  touch,
  originalRequest,
  onReveal,
}: {
  brief: TaskBriefV1
  touch: boolean
  originalRequest: string | null
  onReveal?: Reveal
}) {
  return (
    <>
      <Row label="Goal" touch={touch}>
        {brief.goal ? (
          <AgentText text={brief.goal} />
        ) : (
          <span className="text-muted-foreground">
            Not stated in this report
            {onReveal && originalRequest && (
              <>
                {" · "}
                <QuietButton touch={touch} onClick={() => onReveal(originalRequest, 1)}>Original request</QuietButton>
              </>
            )}
          </span>
        )}
      </Row>
      <Row label="Result" touch={touch}>
        <AgentText text={brief.outcome} />
      </Row>
      <Row label="Remaining" touch={touch}>
        {brief.remaining === null ? (
          <span className="text-muted-foreground">The agent could not say what remains.</span>
        ) : brief.remaining.length === 0 ? (
          <span className="text-muted-foreground">Nothing the agent knows of.</span>
        ) : (
          <ul className="list-disc pl-4">
            {brief.remaining.map((item, i) => (
              <li key={`${i}:${item}`}><AgentText text={item} /></li>
            ))}
          </ul>
        )}
      </Row>
      {brief.decision && <DecisionRow decision={brief.decision} touch={touch} />}
      {brief.scopeChange && (
        <Row label="Scope" touch={touch}>
          <AgentText text={brief.scopeChange} />
        </Row>
      )}
    </>
  )
}

const OPTION_TEXT = "text-[12.5px] leading-[1.55] text-fg-secondary"

function DecisionRow({ decision, touch }: { decision: NonNullable<TaskBriefV1["decision"]>; touch: boolean }) {
  const [compare, setCompare] = useState(false)
  const id = useId()
  const count = decision.options.length
  const recommended = recommendedOption(decision.options.map((option) => option.label), decision.recommendation)
  return (
    <Row label="Decision" touch={touch}>
      <div className="font-medium"><AgentText text={decision.question} /></div>
      {decision.recommendation && (
        <div className="text-fg-secondary">
          <AgentText text={`Recommends: ${decision.recommendation}`} />
        </div>
      )}
      <button
        type="button"
        aria-expanded={compare}
        aria-controls={compare ? id : undefined}
        onClick={() => setCompare(!compare)}
        className={cn("mt-1 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground", touch && "min-h-11")}
      >
        <ChevronRight className={cn("size-2.5 transition-transform motion-reduce:transition-none", compare && "rotate-90")} />
        {compare ? "Hide options" : count === 1 ? "Show the option" : `Compare ${count} options`}
      </button>
      {compare && (
        <div id={id} className="mt-2.5 flex flex-col gap-3 border-l border-border pl-3">
          {decision.options.map((option, index) => (
            <div key={`${index}:${option.label}`}>
              <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] font-medium text-foreground">
                {option.label}
                {index === recommended && (
                  <span className="flex items-center gap-1 text-[11.5px] font-normal text-muted-foreground">
                    <Check className="size-3" aria-hidden />
                    Recommended
                  </span>
                )}
              </div>
              <dl className="mt-1 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                {([
                  ["Gain", option.gain],
                  ["Downside", option.downside],
                  ["Affects", option.impact],
                  ["Effort", option.effort ?? "Not assessed"],
                ] as const).map(([term, value]) => (
                  <div key={term} className="contents">
                    <dt className="pt-px text-[11.5px] text-muted-foreground">{term}</dt>
                    <dd><AgentText text={value} className={OPTION_TEXT} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {decision.unknowns && decision.unknowns.length > 0 && (
            <div>
              <div className="text-[11.5px] text-muted-foreground">Unknown</div>
              <ul className="mt-0.5 list-disc pl-4">
                {decision.unknowns.map((unknown, i) => <li key={`${i}:${unknown}`}><AgentText text={unknown} className={OPTION_TEXT} /></li>)}
              </ul>
            </div>
          )}
          {decision.alternativesNote && (
            <div>
              <div className="text-[11.5px] text-muted-foreground">Alternatives</div>
              <AgentText text={decision.alternativesNote} className={OPTION_TEXT} />
            </div>
          )}
        </div>
      )}
    </Row>
  )
}
