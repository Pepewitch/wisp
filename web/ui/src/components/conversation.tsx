import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { ActivityList } from "@/components/activity-list"
import { ArrowUp, ChevronRight, Dismiss, Pencil } from "@/components/icons"
import { MessageAttachments } from "@/components/message-attachments"
import { Prose } from "@/components/prose"
import { TurnAttachments } from "@/components/turn-attachments"
import { useCancelQueuedMessage, useUpdateQueuedMessage } from "@/hooks/mutations"
import {
  activityByTurn,
  anchoredMessageIds,
  conclusionText,
  fetchTurnActivity,
  splitByMessage,
  type TurnActivity,
} from "@/lib/activity"
import { duration } from "@/lib/state"
import { useDaemonRuntime, useDaemonTransport } from "@/lib/runtime"
import type { TaskDetail, TaskMessage, Turn } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"
import type { StreamState } from "@/stream/reducer"

/* ────────────────────────────────────────────────────────────────────────
   THE SCROLL CONTRACT (skills/wisp-dev/references/frontend.md §5)

   1. ONE scroller owns the whole task. Every turn from GET /api/tasks/:id
      renders eagerly — no clamp, no nested overflow, no pagination.
   2. Activity rows are SUMMARY LINES, in the order the harness emitted them:
      a tool call, the prose that explains the next one, the next call. A live
      turn's timeline comes from the log stream; a settled turn's is fetched on
      demand and dropped on collapse. Logs cap at 5MB per turn: eager bodies
      kill the tab.
   3. The live turn appends into the same list. overflow-anchor + a 60px pin
      threshold; a group opening above the viewport compensates scrollTop.
   4. Raw format replaces the pane — it never interleaves.
   5. A message steered INTO a running turn is part of that turn's order, not
      part of its prompt. The daemon anchors it in the turn's log at native
      admission; the timeline is split at that anchor so the bubble sits
      immediately before whatever the harness did next. A message with no
      anchor — an older log, or a turn whose timeline is not on screen —
      falls back to the turn's head rather than being hidden.
   ──────────────────────────────────────────────────────────────────────── */

const PIN_THRESHOLD = 60

export function Conversation({
  task,
  stream,
  note,
}: {
  task: TaskDetail | null
  /** the live log follow; its blocks belong to the newest turn(s) */
  stream: StreamState
  /** "connecting…" / "select a task" — the stream's own placeholder */
  note?: string | null
}) {
  const runtime = useDaemonRuntime()
  const uiIntents = uiIntentsFor(runtime.connectionId)
  const viewport = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  const live = activityByTurn(stream.blocks)
  const { queuedMessages, steeredMessages, uncertainStarts } = useMemo(() => {
    const queuedMessages: TaskMessage[] = []
    const steeredMessages = new Map<number, TaskMessage[]>()
    const uncertainStarts = new Set<number>()
    for (const message of task?.messages ?? []) {
      if (message.status === "queued" || (message.status === "cancelled" && message.delivery_uncertain)) {
        queuedMessages.push(message)
      } else if (message.delivery === "steered" && message.turn_n !== null) {
        const group = steeredMessages.get(message.turn_n)
        if (group) group.push(message)
        else steeredMessages.set(message.turn_n, [message])
      } else if (message.delivery === "started" && message.turn_n !== null && message.delivery_uncertain) {
        uncertainStarts.add(message.turn_n)
      }
    }
    return { queuedMessages, steeredMessages, uncertainStarts }
  }, [task?.messages])

  // `/log` (A2): the palette asks, this scroller answers. A monotonic counter,
  // so a second request while already pinned is still a request.
  const focusRequests = useSyncExternalStore(uiIntents.subscribe, uiIntents.streamFocusRequests)

  useLayoutEffect(() => {
    const el = viewport.current
    if (pinned && el) el.scrollTop = el.scrollHeight
  }, [runtime.connectionId, task?.id, task?.turns.length, task?.messages?.length, stream.blocks, pinned, focusRequests])

  // a task switch is a fresh read: pin to the tail again (adjusted during
  // render so the first paint of the new task is already pinned). A `/log`
  // request is the same move, asked for out loud.
  const taskIdentity = `${runtime.connectionId}:${task?.id ?? ""}`
  const [seenTask, setSeenTask] = useState(taskIdentity)
  const [seenFocus, setSeenFocus] = useState(focusRequests)
  if (seenTask !== taskIdentity) {
    setSeenTask(taskIdentity)
    setPinned(true)
  }
  if (seenFocus !== focusRequests) {
    setSeenFocus(focusRequests)
    setPinned(true)
  }

  const onScroll = () => {
    const el = viewport.current
    if (!el) return
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD)
  }



  /** Rule 3: keep the reader's line still when something above it grows. */
  const compensate = useCallback((node: HTMLElement | null, before: number) => {
    const el = viewport.current
    if (!el || !node) return
    if (node.getBoundingClientRect().top >= el.getBoundingClientRect().top) return
    el.scrollTop += el.scrollHeight - before
  }, [])

  if (!task) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-faint">
        {note ?? "Select a task to see its conversation"}
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-(--z-pane) h-6 bg-gradient-to-b from-background from-30% to-transparent"
      />

      <div
        ref={viewport}
        onScroll={onScroll}
        tabIndex={-1}
        data-testid="conversation-viewport"
        className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4.5 outline-none [overflow-anchor:auto]"
      >
        {/* Bottom-aligned while the transcript is shorter than the pane: a
            two-line conversation belongs just above the composer, not floating
            at the top of 600px of nothing. Once it overflows, this is inert. */}
        <div className="flex min-h-full flex-col justify-end pt-6">
          {task.turns.length === 0 && note && <div className="pt-4 text-[12.5px] text-faint">{note}</div>}
          {task.turns.map((turn, i) => (
            <TurnBlock
              key={`${runtime.connectionId}:${task.id}:${turn.n}`}
              taskId={task.id}
              turn={turn}
              messages={steeredMessages.get(turn.n) ?? []}
              deliveryUncertain={uncertainStarts.has(turn.n)}
              live={live[turn.n]}
              first={i === 0}
              latest={i === task.turns.length - 1}
              // Why the task failed, on the turn that failed it. The harness's
              // own last words often are the conclusion — droid, for one,
              // pattern-matches its final message and exits 1 on a hit, so the
              // real result ends up here and nowhere else.
              failure={i === task.turns.length - 1 && task.state === "failed" ? task.state_detail : null}
              archived={task.archived}
              onBeforeToggle={compensate}
            />
          ))}
          {queuedMessages.map((message) => (
            <QueuedMessage
              key={`${runtime.connectionId}:${message.id}`}
              taskId={task.id}
              message={message}
              archived={task.archived}
            />
          ))}
          <div className="h-4 shrink-0" />
        </div>
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => setPinned(true)}
          className={cn(
            "absolute right-4 bottom-3 flex h-7 items-center gap-1.5 rounded-full",
            "border border-border-strong bg-card px-3 text-[11.5px] text-fg-secondary",
            "shadow-float transition-colors hover:text-foreground",
          )}
        >
          <ArrowUp className="size-3 rotate-180" />
          Jump to latest
        </button>
      )}
    </div>
  )
}

/**
 * One turn. No "Turn N" rule — the right-aligned bubble is the boundary and
 * the gap carries the rhythm (30px above a bubble, 16px inside a turn).
 */
function TurnBlock({
  taskId,
  turn,
  messages,
  deliveryUncertain,
  live,
  first,
  latest,
  failure = null,
  archived = false,
  onBeforeToggle,
}: {
  taskId: string
  turn: Turn
  messages: TaskMessage[]
  /** This turn replayed a row whose prior native admission was indeterminate. */
  deliveryUncertain: boolean
  live?: TurnActivity
  first: boolean
  latest: boolean
  /** the task's state_detail, on the turn that failed it */
  failure?: string | null
  /** archived tasks keep their manifests but not their image bytes (A1a / Q4) */
  archived?: boolean
  onBeforeToggle: (node: HTMLElement | null, before: number) => void
}) {
  const elapsed = duration(turn.started_at, turn.ended_at)
  const running = turn.status === "running"
  // a settled turn's on-demand activity lives here (lifted from Activity) so
  // the conclusion rule below can see it
  const [expanded, setExpanded] = useState<TurnActivity | null>(null)

  /**
   * The block under the timeline is the turn's CONCLUSION — `turn.result`,
   * the turn's concluding prose (the parse layer derives it from the
   * assistant events; it is never a harness-specific terminal-event blob).
   * It renders only when it ADDS something (conclusionText): a timeline on
   * screen that already shows that prose in full makes the block a verbatim
   * repeat, while a truncated or absent timeline makes it the only full
   * copy. A running turn deliberately gets none either way — its prose is
   * interleaved into the timeline above, beside the steps it explains.
   *
   * A FAILED turn usually has no result: the harness died, or exited non-zero
   * before emitting one, so the column showed tool calls and then nothing, as
   * if the agent had said nothing at all. Everything it did say is in the log,
   * which is why that turn opens its timeline unasked — the prose comes back
   * IN PLACE now, rather than as a separate recovered block down here.
   */
  const settledWithoutResult = !running && !turn.result
  const timeline = live ?? expanded
  // Rule 5: only a timeline that is on screen can place a message. Everything
  // it cannot place still renders, at the head of the turn.
  const timelineItems = timeline?.items
  const anchored = useMemo(() => anchoredMessageIds(timelineItems ?? []), [timelineItems])
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const unanchored = messages.filter((message) => !anchored.has(message.id))
  // Live frames need only their activity items. Avoid materializing the
  // accumulated parent prose until a settled turn needs duplicate detection.
  const conclusion = conclusionText(turn, running ? undefined : timeline?.text)

  return (
    <article data-turn={turn.n} data-status={turn.status} className={first ? "" : "pt-[30px]"}>
      <div className="flex justify-end">
        <div
          data-turn-prompt
          className={cn(
            "max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card",
            "px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/90",
          )}
        >
          {turn.prompt}
          {deliveryUncertain && (
            <div className="mt-1 text-[10.5px] text-faint">
              retried after an unconfirmed delivery; an earlier process may also have received it
            </div>
          )}
        </div>
      </div>

      {/* what the person sent WITH the prompt, so it hangs off the bubble */}
      <TurnAttachments taskId={taskId} turn={turn.n} attachments={turn.attachments ?? []} archived={archived} />

      {unanchored.map((message) => (
        <SteeredMessage key={message.id} taskId={taskId} message={message} archived={archived} />
      ))}

      <Activity
        taskId={taskId}
        turn={turn}
        live={live}
        loaded={expanded}
        onLoaded={setExpanded}
        autoLoad={latest && settledWithoutResult}
        onBeforeToggle={onBeforeToggle}
        renderMessage={(id) => {
          const message = byId.get(id)
          // The log says a delivery landed here; the row says what it WAS. A
          // message the row does not report as steered (still queued, or
          // cancelled after an unconfirmed admission) keeps its own honest
          // placement and wording rather than borrowing this one.
          return message ? <SteeredMessage taskId={taskId} message={message} archived={archived} /> : null
        }}
      />

      {conclusion && <Prose text={conclusion} className="mt-4" />}

      {running && !live?.items.length && (
        <div className="mt-3.5 flex items-center gap-2 text-[11.5px] text-faint">
          <span className="size-1.5 animate-pulse rounded-full bg-state-running" />
          Working…
        </div>
      )}

      {failure && (
        <div className="mt-3.5 rounded-md border border-border bg-card px-3 py-2">
          <div className="text-[10.5px] font-semibold tracking-[0.075em] text-state-failed uppercase">Why it failed</div>
          <div className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap text-fg-secondary">{failure}</div>
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2 text-[10.5px] text-faint">
        {elapsed && <span>{elapsed}</span>}
        {turn.status === "failed" && <span className="text-state-failed">failed</span>}
        {turn.status === "interrupted" && <span>interrupted</span>}
        {turn.model && <span className="font-mono">{turn.model}</span>}
      </div>
    </article>
  )
}

/**
 * One message that reached a RUNNING turn. Same bubble wherever it lands —
 * only its position changes — so an anchored steer and an unanchored one are
 * never told apart by their styling, and neither is ever confused with the
 * separately worded queued-for-the-next-turn bubble below the transcript.
 */
function SteeredMessage({
  taskId,
  message,
  archived,
}: {
  taskId: string
  message: TaskMessage
  archived: boolean
}) {
  return (
    <div data-steered-message={message.id} className="mt-3">
      <div className="flex justify-end">
        <div
          className={cn(
            "max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card",
            "px-3.5 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/90",
          )}
        >
          {message.text}
          <div className="mt-1 text-[10.5px] text-faint">sent during this turn</div>
          {message.delivery_uncertain && (
            <div className="mt-1 text-[10.5px] text-faint">
              delivery retried after an unconfirmed native admission
            </div>
          )}
        </div>
      </div>
      <MessageAttachments
        taskId={taskId}
        messageId={message.id}
        attachments={message.attachments}
        archived={archived}
      />
    </div>
  )
}

function QueuedMessage({
  taskId,
  message,
  archived,
}: {
  taskId: string
  message: TaskMessage
  archived: boolean
}) {
  const update = useUpdateQueuedMessage()
  const cancel = useCancelQueuedMessage()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const busy = update.isPending || cancel.isPending
  const cancelled = message.status === "cancelled"

  const save = () => {
    const text = draft.trim()
    if (!text || text === message.text) {
      setEditing(false)
      setDraft(message.text)
      return
    }
    update.mutate(
      { taskId, messageId: message.id, message: text },
      { onSuccess: () => setEditing(false) },
    )
  }

  return (
    <article data-message={message.id} data-status={message.status} className="pt-[30px]">
      <div className="flex justify-end">
        <div className="max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card px-3.5 py-2.5">
          {editing ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-16 w-full resize-y bg-transparent text-[12.5px] leading-relaxed text-foreground/90 outline-none"
            />
          ) : (
            <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-foreground/90">{message.text}</div>
          )}
          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-faint">
            <span>
              {archived
                ? "not delivered; task is archived"
                : cancelled
                  ? "retry cancelled; prior delivery may already have succeeded"
                : message.delivery_uncertain
                  ? "queued for retry; prior delivery may already have succeeded"
                  : "queued for the next turn"}
            </span>
            <span className="flex-1" />
            {!archived && !cancelled && (editing ? (
              <>
                <button type="button" disabled={busy} className="hover:text-foreground" onClick={save}>
                  Save
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="hover:text-foreground"
                  onClick={() => {
                    setEditing(false)
                    setDraft(message.text)
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Edit queued message"
                  title="Edit queued message"
                  className="hover:text-foreground disabled:opacity-50"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Cancel queued message"
                  title="Cancel queued message"
                  className="hover:text-foreground disabled:opacity-50"
                  onClick={() => cancel.mutate({ taskId, messageId: message.id })}
                >
                  <Dismiss className="size-3" />
                </button>
              </>
            ))}
          </div>
        </div>
      </div>
      <MessageAttachments
        taskId={taskId}
        messageId={message.id}
        attachments={message.attachments}
        archived={archived}
        cancelled={cancelled}
      />
      {(update.error || cancel.error) && (
        <div className="mt-1 text-right text-[10.5px] text-state-failed">
          {String((update.error ?? cancel.error) instanceof Error ? (update.error ?? cancel.error)?.message : "Request failed")}
        </div>
      )}
    </article>
  )
}

/**
 * A turn's timeline: tool calls, thinking and prose in the order they
 * happened. The live turn's arrives over SSE; a settled turn's is fetched only
 * when asked for (rule 2) and thrown away on collapse.
 */
function Activity({
  taskId,
  turn,
  live,
  loaded,
  onLoaded,
  autoLoad = false,
  onBeforeToggle,
  renderMessage,
}: {
  taskId: string
  turn: Turn
  live?: TurnActivity
  /** a settled turn's fetched timeline — owned by TurnBlock so the conclusion rule can see it */
  loaded: TurnActivity | null
  onLoaded: (activity: TurnActivity | null) => void
  /** fetch on mount instead of waiting for a click — a turn with no result row */
  autoLoad?: boolean
  onBeforeToggle: (node: HTMLElement | null, before: number) => void
  /** rule 5: what to draw at a message anchor, resolved against the task's rows */
  renderMessage: (messageId: string) => ReactNode
}) {
  const transport = useDaemonTransport()
  const [loading, setLoading] = useState(false)
  const node = useRef<HTMLDivElement>(null)
  const request = useRef<AbortController | null>(null)

  const activity = live ?? loaded
  const items = activity?.items
  const segments = useMemo(() => splitByMessage(items ?? []), [items])

  const load = () => {
    if (loading) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    const before = node.current?.closest("[data-testid=conversation-viewport]")?.scrollHeight ?? 0
    void fetchTurnActivity(taskId, turn.n, { transport, signal: controller.signal })
      .then((a) => {
        if (controller.signal.aborted) return
        request.current = null
        onLoaded(a)
        setLoading(false)
        requestAnimationFrame(() => onBeforeToggle(node.current, before))
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return
        request.current = null
        setLoading(false)
      })
  }

  useEffect(() => () => request.current?.abort(), [])

  // A failed turn's output belongs on screen when you open the task, not
  // behind a click: you are looking at that turn BECAUSE it failed.
  useEffect(() => {
    if (!autoLoad || live) return
    const controller = new AbortController()
    request.current = controller
    void fetchTurnActivity(taskId, turn.n, { transport, signal: controller.signal })
      .then((a) => {
        if (!controller.signal.aborted) onLoaded(a)
      })
      .catch(() => {})
    return () => {
      controller.abort()
      if (request.current === controller) request.current = null
    }
  }, [autoLoad, live, taskId, turn.n, onLoaded, transport])

  if (!activity) {
    // nothing rendered for a turn with no tool calls to show yet — one quiet
    // affordance, and only for turns that actually ran
    if (turn.status === "running") return null
    return (
      <div ref={node} className="mt-3.5">
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 text-[11px] text-faint transition-colors hover:text-muted-foreground"
        >
          <ChevronRight aria-hidden className="size-3" />
          {loading ? "Loading activity…" : "Show activity"}
        </button>
      </div>
    )
  }

  return (
    <div ref={node} className="mt-4 flex flex-col gap-0.5">
      {!live && loaded && (
        <button
          type="button"
          onClick={() => {
            request.current?.abort()
            request.current = null
            onLoaded(null)
            setLoading(false)
          }}
          className="mb-1 flex items-center gap-2 text-[11px] text-faint transition-colors hover:text-muted-foreground"
        >
          <ChevronRight aria-hidden className="size-3 rotate-90" />
          Hide activity
        </button>
      )}
      {segments.map((segment) => (
        <Fragment key={segment.messageId ?? "tail"}>
          {segment.items.length > 0 && <ActivityList items={segment.items} onBeforeToggle={onBeforeToggle} />}
          {segment.messageId && renderMessage(segment.messageId)}
        </Fragment>
      ))}
      {!items?.length && <span className="text-[11px] text-faint">No activity in this turn</span>}
    </div>
  )
}
