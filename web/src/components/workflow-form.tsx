import { useState } from "react"
import type { Workflow, WorkflowDefinition, WorkflowParameter, WorkflowParams } from "../../../shared/workflows"
import { cn } from "@/lib/utils"
import { Button } from "./primitives"

/**
 * One column, always. This form lives in the right column's Workflows pane
 * (~420px), not in a 640px modal, and the two-column grid it used to draw put
 * a number field beside a prompt textarea — two fields of completely different
 * weight sharing a row, which is most of why the old surface read as a
 * bureaucratic form rather than three questions.
 *
 * Order inside a field is label → what it means → the control, so the sentence
 * that explains a box is read before the box, not after it.
 */

const FIELD =
  "mt-1 block w-full rounded-md border border-input bg-surface px-2 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

/** Limits and permissions: real, but not the question you are here to answer. */
const SAFETY = new Set(["maxWakeups", "lifetimeHours", "allowPush", "allowMerge", "reviewers", "excludeAuthors", "includeBots"])
const pad = (value: number) => String(value).padStart(2, "0")
const offsetLabel = (minutes: number) => {
  const sign = minutes < 0 ? "-" : "+"
  const absolute = Math.abs(minutes)
  return `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
}
const offsetSuffix = (minutes: number) => `${minutes < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
const localInput = (instant: string, offset: number | "local") => {
  const date = new Date(instant)
  const minutes = offset === "local" ? -date.getTimezoneOffset() : offset
  return new Date(date.getTime() + minutes * 60_000).toISOString().slice(0, 16)
}
const instantFromInput = (value: string, offset: number | "local") => {
  const date = offset === "local" ? new Date(value) : new Date(`${value}:00${offsetSuffix(offset)}`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ""
}
const initialSchedule = () => new Date(Date.now() + 15 * 60_000).toISOString()
const scheduleFromNow = (amount: number, unit: "minutes" | "hours") =>
  new Date(Date.now() + amount * (unit === "hours" ? 3_600_000 : 60_000)).toISOString()
const FIXED_OFFSETS = Array.from(new Set([
  ...Array.from({ length: 53 }, (_, index) => -720 + index * 30),
  345, 525, 765,
])).sort((a, b) => a - b)

function ScheduleField({
  value,
  setValue,
  disabled,
  existing,
}: {
  value: string
  setValue: (value: string) => void
  disabled: boolean
  existing: boolean
}) {
  const [mode, setMode] = useState<"relative" | "absolute">(existing ? "absolute" : "relative")
  const [amount, setAmount] = useState(15)
  const [unit, setUnit] = useState<"minutes" | "hours">("minutes")
  const [zone, setZone] = useState<number | "local">("local")
  const target = new Date(value)
  const valid = Number.isFinite(target.getTime())
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const localOffset = -(valid ? target : new Date()).getTimezoneOffset()
  const updateRelative = (nextAmount: number, nextUnit = unit) => {
    setAmount(nextAmount)
    setValue(scheduleFromNow(nextAmount, nextUnit))
  }
  const updateZone = (next: number | "local") => {
    setZone(next)
    const wall = localInput(value, zone)
    setValue(instantFromInput(wall, next))
  }
  return (
    <fieldset disabled={disabled}>
      <legend className="text-[12.5px] font-medium">When</legend>
      <div className="mt-1 flex rounded-md border border-input bg-surface p-0.5">
        {(["relative", "absolute"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={mode === choice}
            onClick={() => {
              setMode(choice)
              if (choice === "relative") updateRelative(amount)
            }}
            className={cn(
              "flex-1 rounded-sm px-2 py-1 text-[12px] transition-colors",
              mode === choice ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {choice === "relative" ? "After a delay" : "Date and time"}
          </button>
        ))}
      </div>
      {mode === "relative" ? (
        <div className="mt-2 flex gap-1.5">
          <label className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
            Delay
            <input
              className={FIELD}
              type="number"
              min={1}
              max={10080}
              step={1}
              value={amount}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (Number.isSafeInteger(next) && next >= 1) updateRelative(next)
              }}
            />
          </label>
          <label className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
            Unit
            <select
              className={FIELD}
              value={unit}
              onChange={(event) => {
                const next = event.target.value as "minutes" | "hours"
                setUnit(next)
                updateRelative(amount, next)
              }}
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-[11.5px] text-muted-foreground">
            Date and time
            <input
              className={FIELD}
              type="datetime-local"
              value={localInput(value, zone)}
              onChange={(event) => setValue(instantFromInput(event.target.value, zone))}
            />
          </label>
          <label className="text-[11.5px] text-muted-foreground">
            Time zone
            <select
              className={FIELD}
              value={zone}
              onChange={(event) => updateZone(event.target.value === "local" ? "local" : Number(event.target.value))}
            >
              <option value="local">Local · {localZone} ({offsetLabel(localOffset)})</option>
              {FIXED_OFFSETS.map((offset) => <option key={offset} value={offset}>{offset === 0 ? "UTC" : offsetLabel(offset)}</option>)}
            </select>
          </label>
        </div>
      )}
      {valid && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Sends {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(target)}
          {" · "}{target.toISOString()}
        </p>
      )}
    </fieldset>
  )
}

function ParameterField({
  parameter: p,
  value,
  setValue,
  disabled,
}: {
  parameter: WorkflowParameter
  value: string | number | boolean
  setValue: (value: string | number | boolean) => void
  disabled: boolean
}) {
  if (p.type === "boolean") {
    return (
      <label className="flex items-start gap-2 text-[12.5px]">
        <input
          type="checkbox"
          className="mt-0.5 shrink-0"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => setValue(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="block">{p.label}</span>
          {p.description && <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">{p.description}</span>}
        </span>
      </label>
    )
  }
  return (
    <label className="block text-[12.5px]">
      <span className="block font-medium">{p.label}</span>
      {p.description && <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">{p.description}</span>}
      {p.multiline ? (
        <textarea
          className={cn(FIELD, "min-h-16 resize-y leading-relaxed")}
          value={String(value)}
          required={p.required}
          maxLength={16000}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input
          // cn(), not a template literal: `w-24` and FIELD's `w-full` are the
          // same utility, and only tailwind-merge reliably drops the loser
          className={cn(FIELD, p.type === "number" && "w-24")}
          type={p.type === "number" ? "number" : p.key === "prUrl" ? "url" : "text"}
          value={String(value)}
          min={p.min}
          max={p.max}
          step={1}
          required={p.required}
          disabled={disabled}
          onChange={(e) => setValue(p.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
        />
      )}
    </label>
  )
}

export function WorkflowForm({
  definition,
  existing,
  prUrl,
  pending,
  onSubmit,
  onCancel,
}: {
  definition: WorkflowDefinition
  existing?: Workflow
  prUrl?: string
  pending: boolean
  onSubmit: (params: WorkflowParams) => void
  onCancel: () => void
}) {
  const [openedAt] = useState(Date.now)
  const [params, setParams] = useState<WorkflowParams>(() => ({
    ...Object.fromEntries(definition.parameters.map((p) => [
      p.key,
      p.key === "prUrl" && prUrl ? prUrl : p.key === "scheduledAt" && !existing ? initialSchedule() : p.default,
    ])),
    ...existing?.params,
  }))
  const field = (p: WorkflowParameter) => (
    <ParameterField
      key={p.key}
      parameter={p}
      value={params[p.key] ?? p.default}
      disabled={pending || (!!existing && p.key === "prUrl")}
      setValue={(value) => setParams((previous) => ({ ...previous, [p.key]: value }))}
    />
  )
  const scheduleError = definition.id === "schedule-steer" &&
    (!Number.isFinite(Date.parse(String(params.scheduledAt))) || Date.parse(String(params.scheduledAt)) <= openedAt)
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!scheduleError) onSubmit(params) }} className="px-1.5 pt-1">
      <h3 className="text-[12.5px] font-medium">
        {existing ? "Configure" : "Add"} {definition.name}
      </h3>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{definition.description}</p>

      <div className="mt-3 flex flex-col gap-3">
        {definition.parameters.filter((p) => !SAFETY.has(p.key) && p.key !== "scheduledAt").map(field)}
        {definition.id === "schedule-steer" && (
          <ScheduleField
            value={String(params.scheduledAt)}
            setValue={(value) => setParams((previous) => ({ ...previous, scheduledAt: value }))}
            disabled={pending}
            existing={Boolean(existing)}
          />
        )}
        {scheduleError && <p role="alert" className="text-[11.5px] text-destructive">Choose a time in the future.</p>}
      </div>

      {definition.parameters.some((p) => SAFETY.has(p.key)) && <details className="mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer py-1 text-[12px] text-muted-foreground hover:text-foreground">
          Limits and permissions
        </summary>
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          Defaults: 20 wake-ups, 24 hours, no pushing or merging. Instructions guide the agent; they are not a sandbox.
        </p>
        <div className="mt-2.5 flex flex-col gap-3">{definition.parameters.filter((p) => SAFETY.has(p.key)).map(field)}</div>
      </details>}

      {definition.custom && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
          This trusted local plugin runs as your OS user. Only run plugins whose code you trust.
        </p>
      )}

      <div className="sticky bottom-0 mt-4 flex justify-end gap-1.5 border-t border-border bg-sidebar py-2">
        <Button size="md" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="md" tone="primary" type="submit" disabled={pending || scheduleError}>
          {/* `Start`, not `Arm`: the row this creates already offers Pause,
              Resume and Remove, so Start is the one verb that completes the
              set — and it says what pressing it does, which `Arm` only said if
              you already knew the word. */}
          {pending ? "Saving…" : existing ? "Save changes" : "Start"}
        </Button>
      </div>
    </form>
  )
}
