import { useState } from "react"

import type { VerificationStatus, VerificationTaskBody } from "../../../shared/api/auto-review"
import { Menu, MenuNote, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "@/components/menu"
import { ModelMenuGroups } from "@/components/model-menu"
import { Bot } from "@/components/icons"
import { Button } from "@/components/primitives"
import { useActivateVerification, useStartVerificationTask } from "@/hooks/mutations"
import { useHarnesses, useProjectVerification } from "@/hooks/queries"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { failureReason } from "@/lib/api"
import { recipeTaskWords, verificationStateLine } from "@/lib/auto-review-words"
import { orderHarnesses } from "@/lib/model-choice"
import type { HiddenModels } from "@/lib/model-visibility"
import { useDaemonRuntime } from "@/lib/runtime"
import { STATE_DOT, STATE_LABEL } from "@/lib/state"
import { fromNow } from "@/lib/time"
import type { HarnessInfo, ProjectVerifyAgent, RepoInfo, TaskState } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { cn } from "@/lib/utils"

type Mode = VerificationTaskBody["mode"]

/** A line the section says after an action: the daemon's refusal, or what just happened. */
export interface VerificationMessage {
  tone: "error" | "info"
  text: string
  /** the task it started, which the line offers to open */
  taskId?: string
}

/** Everything the Verification section draws, so the gallery can draw it without a daemon. */
export interface VerificationFieldsModel {
  /** undefined while the first read is in flight */
  status: VerificationStatus | undefined
  /** the instant relative times are measured from */
  now: number
  readError: string | null
  harnesses: HarnessInfo[]
  hidden: HiddenModels
  /** the reviewer agent as the form holds it (saved with Save); null = each task's own */
  agent: ProjectVerifyAgent | null
  onAgentChange: (agent: ProjectVerifyAgent | null) => void
  note: string
  onNoteChange: (note: string) => void
  /** the action in flight: `setup`, `improve`, or `fix:<area>` (`fix:` for the whole recipe) */
  starting: string | null
  activating: boolean
  /** a recipe task is already working on it: the daemon refuses a second */
  busy: boolean
  message: VerificationMessage | null
  onStart: (mode: Mode, area?: string) => void
  onActivate: () => void
  /** select a task; absent where nothing can navigate (the gallery) */
  onOpenTask?: (taskId: string) => void
}

/**
 * The project's verification recipe, wired to the daemon: where it stands,
 * the draft to activate, the recipe task working on it, and the buttons that
 * start one. The reviewer agent is the form's (saved with Save, like every
 * other field); the actions here act at once, because a recipe task is a
 * task, not a setting.
 */
export function VerificationSection({
  project,
  agent,
  onAgentChange,
}: {
  project: RepoInfo
  agent: ProjectVerifyAgent | null
  onAgentChange: (agent: ProjectVerifyAgent | null) => void
}) {
  const { connectionId } = useDaemonRuntime()
  const status = useProjectVerification(project.path, true)
  const harnesses = useHarnesses(true)
  const { hidden } = useHiddenModels()
  const start = useStartVerificationTask()
  const activate = useActivateVerification()
  const [note, setNote] = useState("")
  const [message, setMessage] = useState<VerificationMessage | null>(null)
  // opened once; "saved 8 minutes ago" need not tick while the dialog is up
  const [now] = useState(() => Date.now())
  const openTask = (id: string) => uiIntentsFor(connectionId).focusTask(id)

  const onStart = (mode: Mode, area?: string) => {
    if (!agent) return
    setMessage(null)
    start.mutate(
      {
        path: project.path,
        mode,
        ...(area ? { area } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        harness: agent.harness,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
      },
      {
        onSuccess: ({ task }) => {
          setNote("")
          setMessage({ tone: "info", text: `Started ${task.title}.`, taskId: task.id })
          // the task is selected behind the dialog: closing it lands on the task
          openTask(task.id)
        },
        onError: (error) => setMessage({ tone: "error", text: failureReason(error) }),
      },
    )
  }
  const onActivate = () => {
    setMessage(null)
    activate.mutate(
      { path: project.path },
      {
        onSuccess: (done) =>
          setMessage({
            tone: "info",
            text: done.changed ? `Activated recipe ${done.version}.` : `Nothing changed: recipe ${done.version} is already active.`,
          }),
        onError: (error) => setMessage({ tone: "error", text: failureReason(error) }),
      },
    )
  }
  const pendingStart = start.isPending ? start.variables : undefined

  return (
    <VerificationFields
      status={status.data}
      now={now}
      readError={status.error ? failureReason(status.error) : null}
      harnesses={harnesses.data ?? []}
      hidden={hidden}
      agent={agent}
      onAgentChange={onAgentChange}
      note={note}
      onNoteChange={setNote}
      starting={pendingStart ? (pendingStart.mode === "fix" ? `fix:${pendingStart.area ?? ""}` : pendingStart.mode) : null}
      activating={activate.isPending}
      busy={project.verification?.busy === true}
      message={message}
      onStart={onStart}
      onActivate={onActivate}
      onOpenTask={openTask}
    />
  )
}

const AREA_DOT = { attention: "bg-destructive", proven: "bg-state-done", unproven: "bg-border-strong" } as const

/** The section from its model alone — which is also how the gallery draws it. */
export function VerificationFields(model: VerificationFieldsModel) {
  const { status, now, readError, agent, busy, starting, message, onStart, onOpenTask } = model
  if (!status) {
    return (
      <p role={readError ? "alert" : "status"} className={cn("text-[11.5px]", readError ? "text-destructive" : "text-faint")}>
        {readError ?? "Checking verification…"}
      </p>
    )
  }
  const blocked = !agent
    ? "Choose a reviewer agent first: a recipe task runs on it"
    : busy
      ? "A recipe task is already working on this recipe"
      : null
  const startButton = (mode: Mode, label: string, area?: string) => {
    const key = mode === "fix" ? `fix:${area ?? ""}` : mode
    return (
      <Button
        type="button"
        tone="outline"
        size={mode === "fix" ? "sm" : "md"}
        disabled={blocked !== null || starting !== null}
        title={blocked ?? undefined}
        aria-label={mode === "fix" && area ? `Fix ${area}` : undefined}
        onClick={() => onStart(mode, area)}
      >
        {starting === key ? "Starting…" : label}
      </Button>
    )
  }
  const task = status.task && !status.task.archived ? status.task : null
  const working = task && (task.state === "running" || task.state === "creating")

  return (
    <div className="flex flex-col gap-3">
      <div>
        <StateLine
          dot={status.state === "none" ? "bg-border-strong" : "bg-state-done"}
          text={verificationStateLine(status)}
          after={status.activatedAt ? `activated ${fromNow(status.activatedAt, now)}` : null}
        />
        {status.areas.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1 pl-[14px]">
            {status.areas.map((area) => (
              <li key={area.name} className="min-w-0">
                <div className="flex min-h-[22px] items-center gap-2">
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", AREA_DOT[area.attention ? "attention" : area.status])}
                  />
                  <span className="shrink-0 font-mono text-[11.5px] text-foreground">{area.name}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">
                    {area.status === "proven" ? "proven" : "not proven yet"}
                  </span>
                  {area.paths.length > 0 && (
                    <span title={area.paths.join("\n")} className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
                      {area.paths.join(" ")}
                    </span>
                  )}
                  {area.attention && <span className="ml-auto">{startButton("fix", "Fix", area.name)}</span>}
                </div>
                {area.attention && (
                  <p className="pl-[14px] text-[11.5px] leading-relaxed text-destructive">{area.attention}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {status.attention && (
          <div className="mt-1.5 flex items-start gap-2 pl-[14px]">
            <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-destructive">{status.attention}</p>
            {startButton("fix", "Fix")}
          </div>
        )}
      </div>

      {status.draft && (
        <div className="flex flex-wrap items-center gap-2">
          <StateLine
            dot="bg-muted-foreground"
            text={`Draft ready · ${status.draft.areas.length} ${status.draft.areas.length === 1 ? "area" : "areas"}`}
            after={`saved ${fromNow(status.draft.savedAt, now)}`}
          />
          <span className="ml-auto flex items-center gap-1.5">
            {onOpenTask && (
              <Button type="button" size="md" onClick={() => onOpenTask(status.draft!.taskId)}>
                Open its task
              </Button>
            )}
            <Button type="button" tone="outline" size="md" disabled={model.activating} onClick={model.onActivate}>
              {model.activating ? "Activating…" : "Activate draft"}
            </Button>
          </span>
        </div>
      )}

      {task && (
        <div className="flex items-center gap-2">
          <StateLine
            dot={working ? "bg-state-background" : STATE_DOT[task.state as TaskState] ?? "bg-border-strong"}
            text={recipeTaskWords(task)}
            after={STATE_LABEL[task.state as TaskState] ?? task.state}
          />
          {onOpenTask && (
            <Button type="button" size="md" className="ml-auto" onClick={() => onOpenTask(task.id)}>
              Open task
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span className="w-[96px] shrink-0 text-[12px] text-fg-secondary">Reviewer agent</span>
          <AgentPicker harnesses={model.harnesses} hidden={model.hidden} agent={agent} onChange={model.onAgentChange} />
        </div>
        <p className="pl-[108px] text-[11px] leading-relaxed text-faint">
          Reviews each PR head under auto-review, and runs the recipe tasks below. Saved with Save.
        </p>
      </div>

      <textarea
        value={model.note}
        onChange={(event) => model.onNoteChange(event.target.value)}
        rows={2}
        placeholder="A note for the recipe task (optional): what to cover, what keeps failing"
        aria-label="Note for the recipe task"
        className={cn(
          "scroll-slim w-full resize-y rounded-md border border-input bg-surface px-2.5 py-2",
          "text-[12px] leading-[1.6] text-foreground placeholder:text-faint",
          "focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        {status.state === "none" ? startButton("setup", "Set up verification") : startButton("improve", "Improve")}
        {message && (
          <p
            role={message.tone === "error" ? "alert" : "status"}
            className={cn("min-w-0 flex-1 text-[11.5px] leading-relaxed", message.tone === "error" ? "text-destructive" : "text-muted-foreground")}
          >
            {message.text}
            {message.taskId && onOpenTask && (
              <button
                type="button"
                onClick={() => onOpenTask(message.taskId!)}
                className="ml-1.5 rounded-sm text-fg-secondary underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                Open
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

function StateLine({ dot, text, after }: { dot: string; text: string; after: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px]">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      <span className="truncate text-foreground">{text}</span>
      {after && <span className="shrink-0 text-[11.5px] text-muted-foreground">· {after}</span>}
    </div>
  )
}

const encode = (harness: string, model: string) => `${harness}\t${model}`
const OWN = "@@own"

/** Who reviews: "Each task's own agent" (null), or one harness and model, from the composer's model list. */
function AgentPicker({
  harnesses,
  hidden,
  agent,
  onChange,
}: {
  harnesses: HarnessInfo[]
  hidden: HiddenModels
  agent: ProjectVerifyAgent | null
  onChange: (agent: ProjectVerifyAgent | null) => void
}) {
  const selected = agent?.model ? { harness: agent.harness, model: agent.model } : null
  const label = agent ? (
    <>
      {agent.harness}
      {agent.model && <span className="font-mono text-muted-foreground"> · {agent.model}</span>}
    </>
  ) : (
    "Each task's own agent"
  )
  return (
    <Menu icon={<Bot />} label={label} aria-label="Reviewer agent">
      <MenuRadioGroup
        value={agent ? (agent.model ? encode(agent.harness, agent.model) : agent.harness) : OWN}
        onValueChange={(value) => {
          if (value === OWN) return onChange(null)
          const [harness = "", model = ""] = value.split("\t")
          // an effort chosen for this harness elsewhere (the CLI) survives a model change
          const effort = agent?.harness === harness ? agent.effort : undefined
          onChange({ harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
        }}
      >
        <MenuRadioItem value={OWN}>Each task&apos;s own agent</MenuRadioItem>
        <MenuSeparator />
        {harnesses.length === 0 ? (
          <MenuNote>No harnesses reported by the daemon.</MenuNote>
        ) : (
          <ModelMenuGroups
            harnesses={orderHarnesses(harnesses)}
            hidden={hidden}
            revealed={false}
            selected={selected}
            encode={encode}
          />
        )}
      </MenuRadioGroup>
    </Menu>
  )
}
