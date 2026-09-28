import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react"

import { FileViewerProvider } from "@/components/file-viewer"
import { Brief, Check, ChevronRight } from "@/components/icons"
import { Prose } from "@/components/prose"
import { useHarnessFeatures, useTaskBrief } from "@/hooks/queries"
import { useTick } from "@/hooks/useTick"
import { briefBand, recommendedOption, type BriefBandModel, type BriefInputView, type TaskBriefV1 } from "@/lib/brief"
import { useBriefOpen } from "@/lib/brief-open"
import { revealFileHandler } from "@/lib/external-links"
import { useDaemonRuntime } from "@/lib/runtime"
import type { ApiTask } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

/** Hand some words to find-in-task, in the turn they belong to. */
type Reveal = (query: string, turn: number | null) => void

/**
 * The task brief: the header's second band (frontend reference §5k). The
 * header says which task this is; this says where it stands — your latest
 * words as Wisp recorded them, then the agent's own report of goal, result,
 * what remains, and any decision waiting on you.
 *
 * It is READING ONLY. Opening, collapsing, comparing and showing the source
 * never write anything; the one switch that changes generation is the task
 * menu's. Nothing here can send a steer.
 *
 * `children` is the conversation. Band and conversation share one column, so
 * the band's 60% cap is a share of the READING area, never of the header or
 * the composer. On touch an open brief REPLACES the conversation (kept
 * mounted, so its scroll survives) rather than squeezing it into what is left
 * of a phone.
 */
export function BriefedConversation({ task, touch, children }: { task: ApiTask | null; touch: boolean; children: ReactNode }) {
  const { connectionId } = useDaemonRuntime()
  const features = useHarnessFeatures()
  const enabled = features.data?.taskBriefs === true && task?.briefEnabled === true
  const query = useTaskBrief(task?.id ?? null, enabled)
  const now = useTick(enabled)
  const model: BriefBandModel = enabled ? briefBand(query.data, query.error, now) : { kind: "hidden" }
  const [open, setOpen] = useBriefOpen(touch)
  const takeover = touch && open && model.kind === "report"

  // Find-in-task lives in the transcript, which a touch takeover hides: any
  // find request (the task menu's, ⌘F) gives the transcript back first.
  const intents = uiIntentsFor(connectionId)
  const findSeq = useSyncExternalStore(intents.subscribe, () => intents.findRequest()?.seq ?? 0)
  const seenFind = useRef(findSeq)
  useEffect(() => {
    if (findSeq === seenFind.current) return
    seenFind.current = findSeq
    if (takeover) setOpen(false)
  }, [findSeq, takeover, setOpen])
  // The band's own "show it in the conversation" closes a takeover and asks a
  // frame later, so the find runs against a transcript that is on screen.
  const reveal: Reveal = (words, turn) => {
    if (!takeover) return intents.openFind(words, turn)
    setOpen(false)
    requestAnimationFrame(() => intents.openFind(words, turn))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {model.kind !== "hidden" && task && (
        // paths in the agent's prose open the file viewer, as they do in the transcript
        <FileViewerProvider taskId={task.archived ? null : task.id} onReveal={revealFileHandler(connectionId, task.worktree_path ?? null)}>
          <TaskBriefBand
            // per task: nothing opened on one task's brief carries to another's
            key={task.id}
            model={model}
            open={open}
            onOpenChange={setOpen}
            touch={touch}
            onReveal={reveal}
            onRetry={() => void query.refetch()}
          />
        </FileViewerProvider>
      )}
      {/* hidden, not unmounted: the transcript keeps its scroll for when the brief closes */}
      <div hidden={takeover} className={cn("min-h-0 flex-1 flex-col", takeover ? "hidden" : "flex")}>{children}</div>
    </div>
  )
}

/** The band itself, from a model alone — which is also how the gallery draws it. */
export function TaskBriefBand({
  model,
  open,
  onOpenChange,
  touch = false,
  onReveal,
  onRetry,
}: {
  model: Exclude<BriefBandModel, { kind: "hidden" }>
  open: boolean
  onOpenChange: (open: boolean) => void
  touch?: boolean
  onReveal?: Reveal
  onRetry?: () => void
}) {
  if (model.kind === "line") return <BriefLine text={model.text} touch={touch} onRetry={model.retry ? onRetry : undefined} />
  // a new report (another turn or revision) starts with its comparison closed
  return <ReportBand key={model.key} model={model} open={open} onOpenChange={onOpenChange} touch={touch} onReveal={onReveal} />
}

const LABEL = "shrink-0 text-[12.5px] font-medium text-fg-secondary"

/** Nothing to open: empty, unsupported, or a failed read carrying its own repair. */
function BriefLine({ text, touch, onRetry }: { text: string; touch: boolean; onRetry?: () => void }) {
  return (
    <section aria-label="Task brief" className={cn("flex shrink-0 items-center gap-2 border-b border-border px-4.5", touch ? "min-h-11 py-2" : "h-[34px]")}>
      <Brief className="size-3.5 shrink-0 text-faint" aria-hidden />
      <span className={LABEL}>Brief</span>
      <span className={cn("min-w-0 flex-1 text-[12.5px] text-muted-foreground", !touch && "truncate")}>{text}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn("shrink-0 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground", touch && "min-h-11")}
        >
          Retry
        </button>
      )}
    </section>
  )
}

/** One muted metadata line, as spans: it sits inside a button, where a div may not. */
function StatusFacts({ parts }: { parts: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
      {parts.map((part, i) => (
        <span key={i} className="flex shrink-0 items-center gap-2">
          {i > 0 && <span className="text-faint">·</span>}
          {part}
        </span>
      ))}
    </span>
  )
}

function ReportBand({
  model,
  open,
  onOpenChange,
  touch,
  onReveal,
}: {
  model: Extract<BriefBandModel, { kind: "report" }>
  open: boolean
  onOpenChange: (open: boolean) => void
  touch: boolean
  onReveal?: Reveal
}) {
  const bodyId = useId()
  const headline = (
    <>
      {model.headline.label && <span className="text-muted-foreground">{model.headline.label} · </span>}
      {model.headline.text}
    </>
  )
  return (
    <section
      aria-label="Task brief"
      className={cn(
        "@container border-b border-border",
        // overflow insurance only: a typical brief fits without scrolling
        touch && open ? "scroll-slim min-h-0 flex-1 overflow-y-auto" : "scroll-slim max-h-[60%] shrink-0 overflow-y-auto",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => onOpenChange(!open)}
        className={cn(
          // sticky: the way back out stays in reach however far the brief scrolls
          "sticky top-0 z-(--z-pane) flex w-full bg-background text-left transition-colors",
          touch ? "min-h-11 items-start gap-2 px-4 py-2 active:bg-hover" : "h-[34px] items-center gap-2 px-4.5 hover:bg-hover",
        )}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-faint transition-transform motion-reduce:transition-none", open && "rotate-90", touch && "mt-[5px]")} />
        {touch ? (
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={LABEL}>Brief</span>
              <StatusFacts parts={model.status} />
            </span>
            {!open && <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-foreground">{headline}</span>}
          </span>
        ) : (
          <>
            <span className={LABEL}>Brief</span>
            <span className={cn("min-w-0 flex-1 truncate text-[12.5px] text-foreground", open && "invisible")}>{headline}</span>
            <StatusFacts parts={model.status} />
          </>
        )}
      </button>
      {open && (
        <div id={bodyId} className={cn("flex flex-col gap-2.5 pb-3.5", touch ? "px-4" : "pr-4.5 pl-[39px]")}>
          {model.input && <InputRow key={model.input.key} input={model.input} touch={touch} onReveal={onReveal} />}
          <div className="flex items-center gap-3 pt-0.5">
            <span className="shrink-0 text-[10.5px] text-faint">{model.divider}</span>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </div>
          <ReportRows brief={model.brief} touch={touch} originalRequest={model.originalRequest} onReveal={onReveal} />
        </div>
      )}
    </section>
  )
}

function Row({ label, children, touch }: { label: string; children: ReactNode; touch: boolean }) {
  return (
    <div className={cn("grid gap-x-3 gap-y-0.5", !touch && "@min-[520px]:grid-cols-[76px_minmax(0,1fr)]")}>
      <div className="pt-[3px] text-[11.5px] text-muted-foreground">{label}</div>
      <div className="min-w-0 text-[13px] leading-[1.6] text-foreground">{children}</div>
    </div>
  )
}

/** Agent text: rendered by the app's one safe prose path, never as HTML. */
function AgentText({ text, className }: { text: string; className?: string }) {
  return <Prose text={text} mode="static" className={cn("text-[13px] leading-[1.6] text-foreground [&_p]:my-0", className)} />
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

/** The person's own words — exact, cut only where the band says it is cut. */
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
