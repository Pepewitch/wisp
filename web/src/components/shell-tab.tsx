import { useEffect, useRef, type ReactNode } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Dismiss, More } from "@/components/icons"
import { Menu, MenuItem, MenuSeparator } from "@/components/menu"
import { Button, POPOVER_SURFACE } from "@/components/primitives"
import type { PendingKill } from "@/hooks/useShellTabs"
import { cn } from "@/lib/utils"

/*
 * The terminal pane's tab strip: one tab per shell, its ⋯ menu, its rename
 * field, and the confirmation a busy shell's close needs. The active tab is a
 * background pill — no underline, no hue (CONVENTIONS §1).
 */

export function ShellTab({
  label,
  title,
  active,
  closeable,
  renaming,
  renameValue,
  onActivate,
  onClose,
  onRename,
  onRenameCommit,
  onRenameCancel,
  menu,
  touch = false,
}: {
  label: string
  title?: string
  active: boolean
  closeable: boolean
  renaming: boolean
  renameValue: string
  onActivate: () => void
  onClose: () => void
  /** absent where the daemon cannot keep a name */
  onRename?: () => void
  /** `byKey` is Enter rather than a blur, so the shell may take focus back */
  onRenameCommit: (name: string, byKey: boolean) => void
  onRenameCancel: () => void
  menu: ReactNode
  touch?: boolean
}) {
  const self = useRef<HTMLSpanElement>(null)
  // The strip scrolls now, so the tab you just opened or switched to can be
  // sitting off its edge. `nearest` on both axes so a tab already in view is
  // left exactly where it is.
  useEffect(() => {
    if (active) self.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [active])

  // hover cannot reveal anything on a touch screen
  const reveal = active || touch ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"

  return (
    <span
      ref={self}
      className={cn(
        "group/tab flex shrink-0 items-center gap-1 rounded-md pr-1 pl-2.5 transition-colors",
        touch ? "h-11 gap-1.5 pr-1.5 pl-3.5" : "h-[22px]",
        active ? "bg-accent" : "hover:bg-hover",
      )}
    >
      {renaming ? (
        <RenameField value={renameValue} touch={touch} onCommit={onRenameCommit} onCancel={onRenameCancel} />
      ) : (
        <button
          type="button"
          onClick={onActivate}
          onDoubleClick={onRename}
          title={title}
          className={cn(
            // fills its row so the whole tab is the tap target, not just the glyphs
            "flex h-full max-w-[160px] items-center focus-visible:outline-none",
            touch ? "text-[13px]" : "text-[11.5px]",
            active ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="truncate">{label}</span>
        </button>
      )}
      <span className={cn("flex items-center transition-opacity", reveal)}>{menu}</span>
      {closeable && (
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${label}`}
          className={cn(
            "flex items-center justify-center text-muted-foreground transition-opacity hover:text-foreground",
            touch ? "size-8" : "size-4",
            reveal,
          )}
        >
          <Dismiss className={touch ? "size-3.5" : "size-2.5"} />
        </button>
      )}
    </span>
  )
}

/** The tab's label, editable in place. Enter or leaving it saves; Escape does not. */
function RenameField({
  value,
  touch,
  onCommit,
  onCancel,
}: {
  value: string
  touch: boolean
  onCommit: (name: string, byKey: boolean) => void
  onCancel: () => void
}) {
  const field = useRef<HTMLInputElement>(null)
  const settled = useRef(false)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  const settle = (commit: boolean, byKey: boolean) => {
    if (settled.current) return
    settled.current = true
    if (commit) onCommit(field.current?.value ?? "", byKey)
    else onCancel()
  }
  return (
    <input
      ref={field}
      type="text"
      defaultValue={value}
      aria-label="Shell name"
      maxLength={64}
      spellCheck={false}
      autoComplete="off"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          settle(true, true)
        } else if (event.key === "Escape") {
          event.preventDefault()
          settle(false, true)
        }
      }}
      onBlur={() => settle(true, false)}
      className={cn(
        "w-[120px] rounded-sm bg-background px-1 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        touch ? "h-8 text-[13px]" : "h-[18px] text-[11.5px]",
      )}
    />
  )
}

/**
 * The confirmation a close or restart needs while a program is running. The
 * daemon decides that, not this pane: it is the one that can see the shell's
 * foreground, so its sentence is shown as it was sent.
 */
export function ShellKillDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingKill | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const close = pending?.kind === "close"
  return (
    <Dialog.Root open={pending !== null} onOpenChange={(next) => !next && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-scrim" />
        <Dialog.Popup
          className={cn(
            "fixed top-[24vh] left-1/2 z-(--z-modal) w-[min(420px,calc(100vw-3rem))] -translate-x-1/2",
            POPOVER_SURFACE,
            "rounded-xl p-5 shadow-modal outline-none",
          )}
        >
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">
            {close ? `Close ${pending?.label ?? "this shell"}?` : `Restart ${pending?.label ?? "this shell"}?`}
          </Dialog.Title>
          <p className="mt-2 text-[12px] leading-relaxed text-fg-secondary">
            {pending?.reason}. {close ? "Closing the tab" : "Restarting the shell"} hangs it up, which stops it. Jobs
            started with <span className="font-mono">nohup</span> or <span className="font-mono">disown</span> keep
            running.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="lg" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="lg" tone="destructive" onClick={onConfirm}>
              {close ? "Close shell" : "Restart shell"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The ⋯ on a tab: everything you can do to that one shell. */
export function ShellMenu({
  label,
  apple,
  daemonTabs,
  closeable,
  touch,
  onOpen,
  onRename,
  onFind,
  onClear,
  onRestart,
  onClose,
}: {
  label: string
  apple: boolean
  /** a daemon that keeps the tab list; only it can rename or restart */
  daemonTabs: boolean
  closeable: boolean
  touch: boolean
  onOpen: () => void
  onRename: () => void
  onFind: () => void
  onClear: () => void
  onRestart: () => void
  onClose: () => void
}) {
  return (
    <Menu
      label={`${label} options`}
      icon={<More />}
      iconOnly
      touch={touch}
      align="start"
      className={touch ? "size-8" : "size-4 rounded-sm [&>svg]:size-3"}
      onOpenChange={(open) => {
        if (open) onOpen()
      }}
    >
      {daemonTabs && <MenuItem onClick={onRename}>Rename…</MenuItem>}
      <MenuItem onClick={onFind} hint={apple ? "⌘F" : "Ctrl+Alt+F"}>
        Find…
      </MenuItem>
      <MenuItem onClick={onClear} hint={apple ? "⌘K" : undefined}>
        Clear
      </MenuItem>
      <MenuSeparator />
      {daemonTabs && <MenuItem onClick={onRestart}>Restart shell</MenuItem>}
      <MenuItem onClick={onClose} disabled={!closeable}>
        Close shell
      </MenuItem>
    </Menu>
  )
}
