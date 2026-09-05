import { useEffect, useRef, useState, type ReactNode } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Dismiss, Pencil, Prompt, Trash } from "@/components/icons"
import { Menu, MenuAction, MenuNote, MenuRadioGroup, MenuRadioItem } from "@/components/menu"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import { useCreateSuffixPrompt, useDeleteSuffixPrompt, useUpdateSuffixPrompt } from "@/hooks/mutations"
import { useSuffixPrompts } from "@/hooks/queries"
import { failureReason } from "@/lib/api"
import type { SuffixPrompt } from "@/lib/types"
import { cn } from "@/lib/utils"

const CREATE_PROMPT = "@@create-suffix-prompt"

/** Which form the nested dialog shows; `null` is closed. Edit carries the row's record. */
type SuffixDialogState = { mode: "create" } | { mode: "edit"; prompt: SuffixPrompt } | null

/**
 * One daemon-wide suffix choice. The selected prompt never enters the draft:
 * callers submit its id separately and the daemon appends the current text.
 *
 * Each saved row manages itself: the pencil reopens the same nested dialog
 * prefilled, and the trash asks once — a second click on the armed "Delete?"
 * is what actually removes the prompt, so a stray click loses nothing.
 */
export function SuffixPromptPicker({
  value,
  onValueChange,
  onModalOpenChange,
  disabled = false,
  touch = false,
}: {
  value: string | null
  onValueChange: (value: string | null) => void
  /** Lets the create composer suspend its document-level submit shortcut. */
  onModalOpenChange?: (open: boolean) => void
  disabled?: boolean
  touch?: boolean
}) {
  const [dialog, setDialog] = useState<SuffixDialogState>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const query = useSuffixPrompts(menuOpen)
  const remove = useDeleteSuffixPrompt()
  const selected = query.data?.find((prompt) => prompt.id === value)

  const setDialogState = (next: SuffixDialogState) => {
    setDialog(next)
    onModalOpenChange?.(next !== null)
  }

  return (
    <>
      <Menu
        icon={<Prompt />}
        label={selected?.name ?? <span className="text-muted-foreground">Suffix prompt</span>}
        disabled={disabled}
        className={cn("max-w-40", touch && "h-10 max-w-32")}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open)
          if (!open) {
            // a half-armed delete or a stale failure must not survive reopening
            setConfirmingDelete(null)
            remove.reset()
          }
        }}
      >
        <MenuRadioGroup
          value={value ?? ""}
          onValueChange={(next) => {
            if (next === CREATE_PROMPT) {
              setMenuOpen(false)
              setDialogState({ mode: "create" })
            } else {
              onValueChange(next || null)
            }
          }}
        >
          <MenuRadioItem value="">No suffix prompt</MenuRadioItem>
          {query.data?.map((prompt) => (
            <div key={prompt.id} className="relative">
              <MenuRadioItem value={prompt.id} className={confirmingDelete === prompt.id ? "pr-20" : "pr-14"}>
                {prompt.name}
              </MenuRadioItem>
              {confirmingDelete === prompt.id ? (
                <div className="absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5">
                  <button
                    type="button"
                    aria-label={`Confirm delete ${prompt.name}`}
                    disabled={remove.isPending}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") event.stopPropagation()
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      remove.mutate(prompt.id, {
                        onSuccess: () => {
                          setConfirmingDelete(null)
                          // never leave the composer pointing at a prompt that is gone
                          if (value === prompt.id) onValueChange(null)
                        },
                      })
                    }}
                    className={cn(
                      "h-6 rounded-md px-1.5 text-[11.5px] font-medium text-destructive",
                      "hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                      "disabled:pointer-events-none disabled:opacity-45",
                    )}
                  >
                    {remove.isPending ? "Deleting…" : "Delete?"}
                  </button>
                  <RowAction label={`Keep ${prompt.name}`} onClick={() => setConfirmingDelete(null)}>
                    <Dismiss />
                  </RowAction>
                </div>
              ) : (
                <div className="absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5">
                  <RowAction
                    label={`Edit suffix prompt ${prompt.name}`}
                    onClick={() => {
                      setMenuOpen(false)
                      setDialogState({ mode: "edit", prompt })
                    }}
                  >
                    <Pencil />
                  </RowAction>
                  <RowAction
                    label={`Delete suffix prompt ${prompt.name}`}
                    danger
                    onClick={() => setConfirmingDelete(prompt.id)}
                  >
                    <Trash />
                  </RowAction>
                </div>
              )}
            </div>
          ))}
          {query.error && <MenuNote>Suffix prompts unavailable ({failureReason(query.error)})</MenuNote>}
          {remove.error && <MenuNote>Could not delete the prompt ({failureReason(remove.error)})</MenuNote>}
          <MenuAction value={CREATE_PROMPT}>Create a new prompt</MenuAction>
        </MenuRadioGroup>
      </Menu>

      <SuffixPromptDialog
        state={dialog}
        onClose={() => setDialogState(null)}
        onSaved={(id) => {
          // a new prompt becomes the selection; an edit keeps it (the id survived)
          if (dialog?.mode === "create") onValueChange(id)
          setDialogState(null)
        }}
      />
    </>
  )
}

/**
 * An icon button floating over a radio row. Every event that base-ui reads as
 * "the row was chosen" is stopped, so the button acts without also selecting
 * the prompt it manages.
 */
function RowAction({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation()
      }}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        "flex size-6 items-center justify-center rounded-md text-faint",
        "hover:bg-hover hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "[&>svg]:size-3.5",
        danger && "hover:text-destructive",
      )}
    >
      {children}
    </button>
  )
}

function SuffixPromptDialog({
  state,
  onClose,
  onSaved,
}: {
  state: SuffixDialogState
  onClose: () => void
  onSaved: (id: string) => void
}) {
  return (
    <Dialog.Root
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          forceRender
          data-testid="create-suffix-prompt-backdrop"
          className="fixed inset-0 z-(--z-nested-backdrop) bg-black/60"
        />
        <Dialog.Popup
          data-testid="create-suffix-prompt-dialog"
          className={cn(
            "fixed top-[20vh] left-1/2 z-(--z-nested-modal) w-[min(520px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl shadow-modal outline-none",
          )}
        >
          {state !== null && (
            <SuffixPromptForm
              key={state.mode === "edit" ? state.prompt.id : "create"}
              editing={state.mode === "edit" ? state.prompt : null}
              onCancel={onClose}
              onSaved={onSaved}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SuffixPromptForm({
  editing,
  onCancel,
  onSaved,
}: {
  editing: SuffixPrompt | null
  onCancel: () => void
  onSaved: (id: string) => void
}) {
  const [name, setName] = useState(editing?.name ?? "")
  const [prompt, setPrompt] = useState(editing?.prompt ?? "")
  const create = useCreateSuffixPrompt()
  const update = useUpdateSuffixPrompt()
  const pending = create.isPending || update.isPending
  const saveError = editing ? update.error : create.error
  const nameInput = useRef<HTMLInputElement>(null)
  const ready = name.trim() !== "" && prompt.trim() !== "" && !pending

  useEffect(() => nameInput.current?.focus(), [])

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!ready) return
        const fields = { name: name.trim(), prompt: prompt.trim() }
        if (editing) {
          update.mutate({ id: editing.id, ...fields }, { onSuccess: (saved) => onSaved(saved.id) })
        } else {
          create.mutate(fields, { onSuccess: (saved) => onSaved(saved.id) })
        }
      }}
    >
      <div className="border-b border-border px-4 py-3">
        <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
          {editing ? "Edit suffix prompt" : "Create a new suffix prompt"}
        </Dialog.Title>
        <Dialog.Description className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
          Wisp appends this text when you submit, without changing the composer draft.
        </Dialog.Description>
      </div>

      <div className="flex flex-col gap-3.5 px-4 py-3.5">
        <label className="flex flex-col gap-1.5 text-[11.5px] font-medium text-fg-secondary">
          Name
          <input
            ref={nameInput}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Intensive PR review"
            className={cn(
              "h-8 rounded-md border border-input bg-surface px-2.5 text-[12.5px] font-normal text-foreground",
              "placeholder:text-faint focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
            )}
          />
        </label>

        <label className="flex flex-col gap-1.5 text-[11.5px] font-medium text-fg-secondary">
          Prompt
          <textarea
            rows={7}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Review correctness, edge cases, tests, documentation, code cleanliness, and security…"
            className={cn(
              "scroll-slim min-h-32 resize-y rounded-md border border-input bg-surface px-2.5 py-2",
              "text-[12.5px] leading-relaxed text-foreground placeholder:text-faint",
              "focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
            )}
          />
        </label>
      </div>

      {saveError && <div className="px-4 pb-1 text-[11.5px] text-destructive">{failureReason(saveError)}</div>}

      <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button type="button" size="lg" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="lg" tone="primary" disabled={!ready}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  )
}
