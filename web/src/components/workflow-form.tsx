import { useState } from "react"
import type { Workflow, WorkflowDefinition, WorkflowParameter, WorkflowParams } from "../../../shared/workflows"
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
          className={`${FIELD} min-h-16 resize-y leading-relaxed`}
          value={String(value)}
          required={p.required}
          maxLength={16000}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
        />
      ) : (
        <input
          className={p.type === "number" ? `${FIELD} w-24` : FIELD}
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
  const [params, setParams] = useState<WorkflowParams>(() => ({
    ...Object.fromEntries(definition.parameters.map((p) => [p.key, p.key === "prUrl" && prUrl ? prUrl : p.default])),
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
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(params) }} className="px-1.5 pt-1">
      <h3 className="text-[12.5px] font-medium">
        {existing ? "Configure" : "Add"} {definition.name}
      </h3>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{definition.description}</p>

      <div className="mt-3 flex flex-col gap-3">{definition.parameters.filter((p) => !SAFETY.has(p.key)).map(field)}</div>

      <details className="mt-3 border-t border-border pt-2">
        <summary className="cursor-pointer py-1 text-[12px] text-muted-foreground hover:text-foreground">
          Limits and permissions
        </summary>
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          Defaults: 20 wake-ups, 24 hours, no pushing or merging. Instructions guide the agent; they are not a sandbox.
        </p>
        <div className="mt-2.5 flex flex-col gap-3">{definition.parameters.filter((p) => SAFETY.has(p.key)).map(field)}</div>
      </details>

      {definition.custom && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
          This trusted local plugin runs as your OS user. Only arm plugins whose code you trust.
        </p>
      )}

      <div className="sticky bottom-0 mt-4 flex justify-end gap-1.5 border-t border-border bg-sidebar py-2">
        <Button size="md" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="md" tone="primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : existing ? "Save changes" : "Arm workflow"}
        </Button>
      </div>
    </form>
  )
}
