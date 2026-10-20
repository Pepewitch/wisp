import { useMemo, useState } from "react"

import type { VerificationStatus, VerificationTaskBody } from "../../../shared/api/auto-review"
import { Menu, MenuNote, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "@/components/menu"
import { ModelMenuGroups } from "@/components/model-menu"
import { Bot, Effort } from "@/components/icons"
import { Button } from "@/components/primitives"
import { useActivateVerification, useStartVerificationTask } from "@/hooks/mutations"
import { useHarnesses, useProjectVerification } from "@/hooks/queries"
import { useHiddenModels } from "@/hooks/useHiddenModels"
import { failureReason } from "@/lib/api"
import { recipeTaskWords, verificationStateLine } from "@/lib/auto-review-words"
import { readCreateTaskDraft } from "@/lib/drafts"
import { effortOptions } from "@/lib/effort"
import { initialChoice, loadPreferredModel, orderHarnesses } from "@/lib/model-choice"
import type { HiddenModels } from "@/lib/model-visibility"
import { useDaemonRuntime } from "@/lib/runtime"
import { STATE_DOT, STATE_LABEL } from "@/lib/state"
import { fromNow } from "@/lib/time"
import type { HarnessInfo, ProjectVerifyAgent, ProjectVerifySecond, RepoInfo, TaskState } from "@/lib/types"
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
  /**
   * The second reviewer on auto-review's panel as the form shows it: an
   * agent, "off", or null (the same agent as the reviewer). Saved with Save.
   * The picker is drawn only with `onSecondChange`, i.e. on a daemon with
   * `features.reviewPanel`.
   */
  second?: ProjectVerifySecond
  onSecondChange?: (second: ProjectVerifySecond) => void
  /**
   * What a recipe task runs on while the reviewer is each task's own agent:
   * a recipe task belongs to the project, so it has no task's agent to
   * borrow. Picked here for those tasks only, never saved; null when there
   * is no harness to offer. Unused once a reviewer agent is chosen.
   */
  recipeAgent: ProjectVerifyAgent | null
  onRecipeAgentChange: (agent: ProjectVerifyAgent) => void
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
  second = null,
}: {
  project: RepoInfo
  agent: ProjectVerifyAgent | null
  onAgentChange: (agent: ProjectVerifyAgent | null) => void
  /** the second reviewer, on a daemon with the review panel: undefined until a person picks one */
  second?: { value: ProjectVerifySecond | undefined; onChange: (second: ProjectVerifySecond) => void } | null
}) {
  const { connectionId } = useDaemonRuntime()
  const status = useProjectVerification(project.path, true)
  const harnesses = useHarnesses(true)
  const { hidden } = useHiddenModels()
  const start = useStartVerificationTask()
  const activate = useActivateVerification()
  const [note, setNote] = useState("")
  const [recipePick, setRecipePick] = useState<ProjectVerifyAgent | null>(null)
  const [message, setMessage] = useState<VerificationMessage | null>(null)
  // opened once; "saved 8 minutes ago" need not tick while the dialog is up
  const [now] = useState(() => Date.now())
  const openTask = (id: string) => uiIntentsFor(connectionId).focusTask(id)
  // until a person picks one, what a new task in this project would run on
  const newTask = useMemo(() => newTaskAgent(connectionId, project.path, harnesses.data ?? []), [connectionId, project.path, harnesses.data])
  const recipeAgent = recipePick ?? newTask

  const onStart = (mode: Mode, area?: string) => {
    // the reviewer agent when there is one; otherwise the one picked for recipe tasks
    const runsOn = agent ?? recipeAgent
    if (!runsOn) return
    setMessage(null)
    start.mutate(
      {
        path: project.path,
        mode,
        ...(area ? { area } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        harness: runsOn.harness,
        ...(runsOn.model ? { model: runsOn.model } : {}),
        ...(runsOn.effort ? { effort: runsOn.effort } : {}),
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
  // until a person picks one, show what the daemon has: the status's, else the repo entry's
  const secondShown =
    second === null
      ? undefined
      : second.value !== undefined
        ? second.value
        : status.data?.second !== undefined
          ? secondFromStatus(status.data.second)
          : project.verifySecond ?? null

  return (
    <VerificationFields
      status={status.data}
      now={now}
      readError={status.error ? failureReason(status.error) : null}
      harnesses={harnesses.data ?? []}
      hidden={hidden}
      agent={agent}
      onAgentChange={onAgentChange}
      {...(second ? { second: secondShown, onSecondChange: second.onChange } : {})}
      recipeAgent={recipeAgent}
      onRecipeAgentChange={setRecipePick}
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

/**
 * The agent a new task in this project would start on: the create composer's
 * pick for it when one is drafted, else the preferred model, else the first
 * usable harness's default. Its effort is the draft's, or the harness default.
 */
function newTaskAgent(connectionId: string, repoPath: string, harnesses: HarnessInfo[]): ProjectVerifyAgent | null {
  const draft = readCreateTaskDraft(connectionId, repoPath)
  const choice = initialChoice(harnesses, draft?.choice ?? loadPreferredModel(connectionId))
  if (!choice) return null
  const drafted = draft?.choice?.harness === choice.harness && draft.choice.model === choice.model
  const effort = drafted ? draft!.effort : ""
  return { harness: choice.harness, model: choice.model, ...(effort ? { effort } : {}) }
}

/** The status's second reviewer (nulls for "its default") as the form holds one. */
function secondFromStatus(second: VerificationStatus["second"]): ProjectVerifySecond {
  if (!second || second === "off") return second ?? null
  return { harness: second.harness, ...(second.model ? { model: second.model } : {}), ...(second.effort ? { effort: second.effort } : {}) }
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
  const blocked = !agent && !model.recipeAgent
    ? "No agent to run a recipe task on: choose one above"
    : busy
      ? "A recipe task is already working on this recipe"
      : null
  const startButton = (mode: Mode, label: string, area?: string) => {
    const key = mode === "fix" ? `fix:${area ?? ""}` : mode
    return (
      <Button
        type="button"
        tone="outline"
        size="lg"
        disabled={blocked !== null || starting !== null}
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
              <Button type="button" size="lg" onClick={() => onOpenTask(status.draft!.taskId)}>
                Open its task
              </Button>
            )}
            <Button type="button" tone="outline" size="lg" disabled={model.activating} onClick={model.onActivate}>
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
            <Button type="button" size="lg" className="ml-auto" onClick={() => onOpenTask(task.id)}>
              Open task
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <span className="w-[96px] shrink-0 text-[12px] text-fg-secondary">Reviewer agent</span>
          <AgentPicker
            harnesses={model.harnesses}
            hidden={model.hidden}
            agent={agent}
            fixed={REVIEWER_FIXED}
            aria-label="Reviewer agent"
            onChange={(next) => model.onAgentChange(next === "off" ? null : next)}
          />
        </div>
        <p className="pl-[108px] text-[11px] leading-relaxed text-faint">
          {model.onSecondChange
            ? "Reviewer A runs the app and reviews each PR head under auto-review; it also runs the recipe tasks below. Saved with Save."
            : "Reviews each PR head under auto-review, and runs the recipe tasks below. Saved with Save."}
        </p>
      </div>

      {model.onSecondChange && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="w-[96px] shrink-0 text-[12px] text-fg-secondary">Second reviewer</span>
            <AgentPicker
              harnesses={model.harnesses}
              hidden={model.hidden}
              agent={model.second ?? null}
              fixed={SECOND_FIXED}
              aria-label="Second reviewer"
              onChange={model.onSecondChange}
            />
          </div>
          <p className="pl-[108px] text-[11px] leading-relaxed text-faint">
            Reviewer B reads the code only, beside A on standard and deep rounds. A different agent gives a real
            second opinion; Off makes every round single-reviewer. Saved with Save.
          </p>
        </div>
      )}

      {!agent && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <span className="w-[96px] shrink-0 text-[12px] text-fg-secondary">Recipe agent</span>
            <AgentPicker
              harnesses={model.harnesses}
              hidden={model.hidden}
              agent={model.recipeAgent}
              fixed={[]}
              aria-label="Recipe agent"
              onChange={(next) => next && next !== "off" && model.onRecipeAgentChange(next)}
            />
          </div>
          <p className="pl-[108px] text-[11px] leading-relaxed text-faint">
            A recipe task belongs to the project, so it has no task&apos;s agent to borrow: the recipe tasks below run
            on this one. Not saved; the reviewer stays each task&apos;s own agent.
          </p>
        </div>
      )}

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
        <ActionNote message={message} blocked={blocked} onOpenTask={onOpenTask} />
      </div>
    </div>
  )
}

/** What the section says after an action, or why its buttons are disabled (a disabled button shows no title and takes no focus). */
function ActionNote({ message, blocked, onOpenTask }: { message: VerificationMessage | null; blocked: string | null; onOpenTask?: (taskId: string) => void }) {
  if (!message) return blocked ? <p className="min-w-0 flex-1 text-[11.5px] leading-relaxed text-muted-foreground">{blocked}</p> : null
  return (
    <p
      role={message.tone === "error" ? "alert" : "status"}
      className={cn("min-w-0 flex-1 text-[11.5px] leading-relaxed", message.tone === "error" ? "text-destructive" : "text-muted-foreground")}
    >
      {message.text}
      {message.taskId && onOpenTask && (
        <Button type="button" size="lg" className="ml-1.5" onClick={() => onOpenTask(message.taskId!)}>
          Open
        </Button>
      )}
    </p>
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

/** A choice above the model list: the one that names no agent of its own. */
interface FixedChoice {
  key: string
  value: "off" | null
  label: string
}

const REVIEWER_FIXED: FixedChoice[] = [{ key: "@@own", value: null, label: "Each task's own agent" }]
const SECOND_FIXED: FixedChoice[] = [
  { key: "@@same", value: null, label: "Same agent as the reviewer" },
  { key: "@@off", value: "off", label: "Off — one reviewer" },
]

const DEFAULT_EFFORT = "@@default"

/**
 * Who reviews: one of the fixed choices ("Each task's own agent"; for the
 * second reviewer "Same agent as the reviewer" and "Off"), or one harness and
 * model from the composer's model list, with its effort beside it. With no
 * fixed choices (the recipe agent) it always names an agent once it has one.
 */
function AgentPicker({
  harnesses,
  hidden,
  agent,
  fixed,
  onChange,
  "aria-label": ariaLabel,
}: {
  harnesses: HarnessInfo[]
  hidden: HiddenModels
  agent: ProjectVerifySecond
  fixed: FixedChoice[]
  onChange: (agent: ProjectVerifySecond) => void
  "aria-label": string
}) {
  const { connectionId } = useDaemonRuntime()
  const named = agent && agent !== "off" ? agent : null
  const choice = named ? null : fixed.find((option) => option.value === agent) ?? fixed[0] ?? null
  const selected = named?.model ? { harness: named.harness, model: named.model } : null
  const harness = named ? harnesses.find((candidate) => candidate.name === named.harness) : undefined
  // the harness's own levels, as the composer offers them, and a level set elsewhere (the CLI) stays visible
  const efforts = harness?.hasEffort ? effortOptions(connectionId, harness) : []
  if (named?.effort && efforts.length > 0 && !efforts.includes(named.effort)) efforts.push(named.effort)
  const label = named ? (
    <>
      {named.harness}
      {named.model && <span className="font-mono text-muted-foreground"> · {named.model}</span>}
    </>
  ) : (
    choice?.label ?? "Choose an agent"
  )
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Menu icon={<Bot />} label={label} aria-label={ariaLabel}>
        <MenuRadioGroup
          value={named ? (named.model ? encode(named.harness, named.model) : named.harness) : choice?.key ?? ""}
          onValueChange={(value) => {
            const pick = fixed.find((option) => option.key === value)
            if (pick) return onChange(pick.value)
            const [harness = "", model = ""] = value.split("\t")
            // the effort chosen for this harness survives a model change; another harness starts at its default
            const effort = named?.harness === harness ? named.effort : undefined
            onChange({ harness, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
          }}
        >
          {fixed.map((option) => (
            <MenuRadioItem key={option.key} value={option.key}>
              {option.label}
            </MenuRadioItem>
          ))}
          {fixed.length > 0 && <MenuSeparator />}
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
      {named && efforts.length > 0 && (
        <Menu
          icon={<Effort />}
          label={named.effort ? `${named.effort} effort` : "Default effort"}
          aria-label={`${ariaLabel} effort`}
        >
          <MenuRadioGroup
            value={named.effort ?? DEFAULT_EFFORT}
            onValueChange={(value) => {
              const effort = value === DEFAULT_EFFORT ? undefined : value
              onChange({ harness: named.harness, ...(named.model ? { model: named.model } : {}), ...(effort ? { effort } : {}) })
            }}
          >
            <MenuRadioItem value={DEFAULT_EFFORT}>Harness default</MenuRadioItem>
            {efforts.map((effort) => (
              <MenuRadioItem key={effort} value={effort}>
                {effort}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </Menu>
      )}
    </span>
  )
}
