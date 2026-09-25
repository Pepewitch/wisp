import { useId, useRef, useState, type ReactNode } from "react"
import type { UseMutationResult } from "@tanstack/react-query"

import { Button } from "@/components/primitives"
import type { SecretKeyStatus, WispSettings } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * A daemon-held API key in Settings: the Review judge's Jev key, and the
 * Factory key droid's limits are read with. A secret, not a preference, so
 * each is one of the modal's few Saves (frontend.md §5g), and the key is
 * write-only in the client too:
 * - the field is uncontrolled, so the key is never React state or a DOM
 *   attribute, and it remounts whenever the key changes, here or from
 *   another client, which drops any draft;
 * - the mutation that carries it is never cached (`gcTime: 0`);
 * - the daemon answers only with whether a key is set, where it came from,
 *   and its last four characters.
 */
export interface SecretKeySpec {
  /** the field's accessible name and placeholder */
  label: string
  /** what a malformed key is told before it is sent */
  malformed: string
  /** the row's note for a key the daemon read from its environment */
  environmentNote: string
  /** when a failure carries no message of its own */
  fallbackError: string
  /** the uncached PATCH for this key; `null` removes it */
  useSave: () => UseMutationResult<WispSettings, Error, string | null>
}

/** The Test button's mutation, whatever its answer looks like. */
export interface SecretKeyProbe<Result> {
  mutate: () => void
  reset: () => void
  isPending: boolean
  data: Result | undefined
  error: Error | null
}

/** The daemon's own rule (routes/settings.ts), checked first so a typo gets a sentence, not a field name. */
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/

export type KeyFocus = "field" | "replace" | "remove" | "confirm"

export function SecretKeyControls<Result>({
  spec,
  status,
  probe,
  notes,
}: {
  spec: SecretKeySpec
  status: SecretKeyStatus
  probe: SecretKeyProbe<Result>
  /** the section's own lines under the row: the last Test's outcome, and any error */
  notes: (result: Result | undefined, error: string | undefined) => ReactNode
}) {
  const remove = spec.useSave()
  // Each of these names the key it was about, so a key changed from anywhere
  // ends a replacement, a pending confirmation, and a test result.
  const [replacing, setReplacing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [tested, setTested] = useState<string | null>(null)
  const asking = !status.configured || replacing === status.hint

  // Focus follows the control that replaces the one it was on; switching
  // between the field and the key's row unmounts the button just pressed.
  const [focus, setFocus] = useState<KeyFocus | null>(null)
  const [wasAsking, setWasAsking] = useState(asking)
  if (wasAsking !== asking) {
    setWasAsking(asking)
    setFocus(asking ? "field" : "replace")
  }

  const current = tested !== null && tested === status.hint
  const result = !asking && current ? probe.data : undefined
  const error = asking ? null : remove.error ?? (current ? probe.error : null)

  return (
    <>
      {asking ? (
        <SecretKeyForm
          key={status.hint ?? "none"}
          spec={spec}
          autoFocus={focus === "field"}
          canCancel={status.configured}
          onCancel={() => setReplacing(null)}
        />
      ) : (
        <SecretKeyRow
          status={status}
          environmentNote={spec.environmentNote}
          focus={focus}
          busy={remove.isPending}
          testing={probe.isPending}
          confirming={confirming !== null && confirming === status.hint}
          onTest={() => {
            remove.reset()
            setTested(status.hint)
            probe.mutate()
          }}
          onReplace={() => {
            setConfirming(null)
            setReplacing(status.hint)
          }}
          onRemove={() => {
            setFocus("confirm")
            setConfirming(status.hint)
          }}
          onKeep={() => {
            setFocus("remove")
            setConfirming(null)
          }}
          onConfirmRemove={() => {
            setTested(null)
            remove.mutate(null)
          }}
        />
      )}
      {notes(result, error ? errorText(error, spec.fallbackError) : undefined)}
    </>
  )
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Its own component so that unmounting it drops the typed key and the mutation that carried it. */
function SecretKeyForm({
  spec,
  autoFocus,
  canCancel,
  onCancel,
}: {
  spec: SecretKeySpec
  autoFocus: boolean
  canCancel: boolean
  onCancel: () => void
}) {
  const save = spec.useSave()
  const field = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState(false)
  const [malformed, setMalformed] = useState(false)
  const errorId = useId()

  const submit = () => {
    const key = field.current?.value.trim() ?? ""
    if (key === "" || save.isPending) return
    if (!KEY_SHAPE.test(key)) {
      setMalformed(true)
      return
    }
    save.mutate(key)
  }
  const error = malformed ? spec.malformed : save.error ? errorText(save.error, spec.fallbackError) : null

  return (
    <>
      {/* no <form>: a password field in a form that vanishes after a fetch reads to a
          browser as a login, and it would offer to save the key or fill in a saved one */}
      <div className="flex items-center gap-2">
        <input
          ref={field}
          type="password"
          aria-label={spec.label}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          spellCheck={false}
          placeholder={spec.label}
          autoFocus={autoFocus}
          readOnly={save.isPending}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => {
            setTyped(event.target.value.trim() !== "")
            setMalformed(false)
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            submit()
          }}
          className={cn(
            "h-[26px] min-w-0 flex-1 rounded-md border border-input bg-surface px-2.5",
            "font-mono text-[11.5px] text-foreground placeholder:font-sans placeholder:text-faint",
            "focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
          )}
        />
        <Button onClick={submit} disabled={save.isPending || !typed}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {canCancel && (
          <Button onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        )}
      </div>
      {error !== null ? (
        <p id={errorId} role="alert" className="mt-1.5 text-[11.5px] text-destructive">
          {error}
        </p>
      ) : (
        typed && (
          <p className="mt-1.5 text-[11px] text-faint">Not saved yet. Save it, or press Enter; Done leaves it unsaved.</p>
        )
      )}
    </>
  )
}

export function SecretKeyRow({
  status,
  environmentNote,
  focus,
  busy,
  testing,
  confirming,
  onTest,
  onReplace,
  onRemove,
  onKeep,
  onConfirmRemove,
}: {
  status: SecretKeyStatus
  environmentNote: string
  focus: KeyFocus | null
  busy: boolean
  testing: boolean
  confirming: boolean
  onTest: () => void
  onReplace: () => void
  onRemove: () => void
  onKeep: () => void
  onConfirmRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* a floor under the text, so on a phone the buttons wrap below it rather than squeeze it */}
      <span className="min-w-40 flex-1">
        <span className="block text-[12.5px] text-fg-secondary">
          Key <span className="font-mono text-[11.5px] text-muted-foreground">{status.hint}</span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
          {status.source === "environment" ? environmentNote : "Saved on this daemon."}
        </span>
      </span>
      {/* keyed, so each set of buttons mounts fresh and autoFocus lands */}
      {confirming ? (
        <span key="confirm" className="flex items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground">Remove the key?</span>
          <Button tone="destructive" onClick={onConfirmRemove} disabled={busy} autoFocus={focus === "confirm"}>
            {busy ? "Removing…" : "Remove"}
          </Button>
          <Button onClick={onKeep} disabled={busy}>
            Keep
          </Button>
        </span>
      ) : (
        <span key="actions" className="flex items-center gap-1.5">
          <Button onClick={onTest} disabled={busy || testing}>
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button onClick={onReplace} disabled={busy} autoFocus={focus === "replace"}>
            Replace…
          </Button>
          {status.source === "settings" && (
            <Button onClick={onRemove} disabled={busy} autoFocus={focus === "remove"}>
              Remove
            </Button>
          )}
        </span>
      )}
    </div>
  )
}
