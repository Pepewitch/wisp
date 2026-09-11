import { useState } from "react"
import type { Workflow, WorkflowDefinition, WorkflowParameter, WorkflowParams } from "../../../shared/workflows"
import { Button } from "./primitives"

const FIELD = "mt-1.5 block w-full rounded-md border border-input bg-surface px-2.5 py-2 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

function ParameterField({ parameter: p, value, setValue, disabled }: {
  parameter: WorkflowParameter
  value: string | number | boolean
  setValue: (value: string | number | boolean) => void
  disabled: boolean
}) {
  return (
    <label className={`block text-[12.5px] ${p.multiline || p.type === "boolean" || p.key === "prUrl" ? "col-span-full" : ""}`}>
      {p.type === "boolean" ? (
        <span className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={e => setValue(e.target.checked)} />
          {p.label}
        </span>
      ) : (
        <>
          <span className="font-medium">{p.label}</span>
          {p.multiline ? (
            <textarea className={`${FIELD} min-h-28 resize-y leading-relaxed`} value={String(value)} required={p.required} maxLength={16000} disabled={disabled} onChange={e => setValue(e.target.value)} />
          ) : (
            <input className={FIELD} type={p.type === "number" ? "number" : p.key === "prUrl" ? "url" : "text"}
              value={String(value)} min={p.min} max={p.max} step={1} required={p.required} disabled={disabled}
              onChange={e => setValue(p.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />
          )}
        </>
      )}
      {p.description && <span className="mt-1 block text-[11.5px] leading-relaxed text-muted-foreground">{p.description}</span>}
    </label>
  )
}

export function WorkflowForm({ definition, existing, prUrl, pending, onSubmit, onCancel }: {
  definition: WorkflowDefinition
  existing?: Workflow
  prUrl?: string
  pending: boolean
  onSubmit: (params: WorkflowParams) => void
  onCancel: () => void
}) {
  const [params, setParams] = useState<WorkflowParams>(() => ({
    ...Object.fromEntries(definition.parameters.map(p => [p.key, p.key === "prUrl" && prUrl ? prUrl : p.default])),
    ...existing?.params,
  }))
  const safety = new Set(["maxWakeups", "lifetimeHours", "allowPush", "allowMerge", "reviewers", "excludeAuthors", "includeBots"])
  const field = (p: WorkflowParameter) => (
    <ParameterField key={p.key} parameter={p} value={params[p.key] ?? p.default}
      disabled={pending || (!!existing && p.key === "prUrl")}
      setValue={value => setParams(previous => ({ ...previous, [p.key]: value }))} />
  )
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(params) }}>
      <h3 className="text-[14.5px] font-semibold">{existing ? "Configure" : "Add"} {definition.name}</h3>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{definition.description}</p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {definition.parameters.filter(p => !safety.has(p.key)).map(field)}
      </div>
      <details className="mt-5 border-t border-border pt-3">
        <summary className="cursor-pointer py-2 text-[12.5px] font-medium">Limits, permissions, and filters</summary>
        <p className="mt-1 text-[11.5px] text-muted-foreground">Defaults: 20 wake-ups, 24 hours, no pushing or merging. Instructions guide the agent, but are not a sandbox.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{definition.parameters.filter(p => safety.has(p.key)).map(field)}</div>
      </details>
      {definition.custom && <p className="mt-3 text-[12px] text-muted-foreground">This trusted local plugin runs as your OS user. Only arm plugins whose code you trust.</p>}
      <div className="sticky bottom-0 mt-5 flex justify-end gap-2 border-t border-border bg-popover py-3">
        <Button size="lg" disabled={pending} onClick={onCancel}>Back</Button>
        <Button size="lg" tone="primary" type="submit" disabled={pending}>{pending ? "Saving…" : existing ? "Save changes" : "Arm workflow"}</Button>
      </div>
    </form>
  )
}
