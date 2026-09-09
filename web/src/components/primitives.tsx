import type { ReactNode } from "react"

import { backgroundLabel, STATE_DOT, STATE_LABEL } from "@/lib/state"
import type { ApiTask, TaskState } from "@/lib/types"
import { cn } from "@/lib/utils"

/* ── the row of small parts every screen is built from ──────────────────── */

/**
 * The state marker. 6px, hue on the dot and nowhere else; `running` gets a
 * violet halo so a live task is findable in a list of thirty.
 *
 * ONE shape, two axes (D-dot). Every marker in the app is a circle — there is
 * no square variant, because a 6px square at a glance reads as a different
 * KIND of object rather than a different state:
 *
 *  - FILL says whose state it is. A filled dot is the agent's own outcome;
 *    a RING is ambient work attached to the task but outside the turn —
 *    background processes here, archive cleanup in `TaskStateDot`.
 *  - HUE says how that work is going, and it is the same hue family either
 *    way, so a ring never needs a colour the filled dots do not already own.
 *
 * `unknown` takes the neutral rather than a warm hue on purpose. It means
 * Wisp could not inventory the process group — no data, nothing to act on —
 * and the two warm hues are 24° apart in OKLCH (`needs-input` 83°, `stuck`
 * 59°): at 6px they are one colour, so spending either here would have said
 * "this task wants you" about a fact that wants nothing.
 *
 * `stopping` keeps the live ring because that is the truth — the work is
 * still there until it is gone — and because `animate-breathe` is reserved
 * for the running indicator (see index.css: a second blinking thing competes
 * with the one that means "this task is alive").
 */
export function StateDot({ state, background, className }: { state: TaskState; background?: ApiTask["background"]; className?: string }) {
  const label = backgroundLabel(background)
  const backgroundOnly = label && state === "done"
  return (
    <span
      data-state={state}
      data-background={background?.state ?? "none"}
      role="img"
      aria-label={label ? `${STATE_LABEL[state]} · ${label}` : STATE_LABEL[state]}
      title={label ? `${STATE_LABEL[state]} · ${label}` : STATE_LABEL[state]}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        backgroundOnly
          ? background?.state === "unknown"
            ? "border-2 border-state-creating bg-transparent"
            : "border-2 border-state-background bg-transparent"
          : STATE_DOT[state],
        state === "running" && "shadow-[0_0_0_3px_var(--accent-wash)]",
        className,
      )}
    />
  )
}

/** The one uppercase label a pane is allowed. More than one per pane is a bug. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("eyebrow", className)}>{children}</span>
}

/**
 * The chrome every floating surface shares: menus, hover cards, the gallery's
 * static copy of one. A CLASS rather than a wrapper component because base-ui
 * owns the element itself (PreviewCard.Popup, Menu.Popup) and only takes a
 * className — so `cn(POPOVER_SURFACE, …)` is the one way to share it.
 *
 * Radius is deliberately not here: a menu is `rounded-lg`, a card `rounded-xl`.
 */
export const POPOVER_SURFACE = "border border-border-strong bg-popover shadow-popover"

/** A hairline. Never <hr>, never a bare border-t div scattered inline. */
export function Rule({ className }: { className?: string }) {
  return <span aria-hidden className={cn("h-px flex-1 bg-border", className)} />
}

type ButtonTone = "quiet" | "outline" | "primary" | "destructive"

const TONE: Record<ButtonTone, string> = {
  // the default: no chrome until you touch it
  quiet: "text-fg-secondary hover:bg-hover hover:text-foreground",
  // a real edge, for an action with a consequence you can undo
  outline: "border-border-strong bg-card text-foreground hover:bg-hover",
  // the one action on the screen. Exactly one, or none.
  primary: "bg-primary text-primary-foreground font-semibold hover:bg-primary-hover",
  // an irreversible action, filled so it cannot read as a low-risk text link
  destructive: "bg-destructive text-destructive-foreground font-semibold hover:bg-destructive-hover",
}

/**
 * 22 / 26 / 32 are the only control heights. `icon` is the square variant —
 * same heights, no horizontal padding.
 */
export function Button({
  tone = "quiet",
  size = "md",
  icon = false,
  disabled = false,
  className,
  children,
  ...rest
}: {
  tone?: ButtonTone
  size?: "sm" | "md" | "lg"
  icon?: boolean
  children?: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent",
        "text-[12px] font-medium transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        "disabled:pointer-events-none disabled:opacity-45",
        size === "sm" && (icon ? "size-[22px]" : "h-[22px] px-2"),
        size === "md" && (icon ? "size-[26px]" : "h-[26px] px-2.5"),
        size === "lg" && (icon ? "size-8" : "h-8 px-3 text-[13px]"),
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * A tab. Selection is a background pill — the accent never marks "which one
 * am I looking at", only "this is live" or "this is the action".
 */
export function Tab({
  active = false,
  count,
  onClick,
  size = "sm",
  className,
  children,
  ...rest
}: {
  active?: boolean
  count?: number | string
  onClick?: () => void
  /** `lg` is the touch size — 44px, the floor for a thumb target */
  size?: "sm" | "lg"
  className?: string
  children: ReactNode
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick" | "className">) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active || undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md transition-colors",
        size === "sm" ? "h-[22px] px-2.5 text-[12px]" : "h-11 px-3.5 text-[13px]",
        active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
      {count !== undefined && <span className="font-mono text-[10.5px] text-muted-foreground">{count}</span>}
    </button>
  )
}

/**
 * A pane's header strip: 36px, one hairline underneath, and a title that is a
 * label rather than a tab when the pane has only one view.
 */
export function PaneHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5 pl-3.5", className)}>
      {children}
    </div>
  )
}

/** A metadata line: dot-separated, muted, one line and never two. */
export function Meta({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter((i) => i !== null && i !== undefined && i !== false && i !== "")
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground", className)}>
      {shown.map((item, i) => (
        <span key={i} className="flex min-w-0 items-center gap-2">
          {i > 0 && <span className="text-faint">·</span>}
          {item}
        </span>
      ))}
    </div>
  )
}

/** The +adds / −dels pair. The only number that earns a row's right edge. */
export function DiffStat({ adds, dels, note }: { adds?: number; dels?: number; note?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
      {adds !== undefined && adds > 0 && <span className="text-diff-add">+{adds}</span>}
      {dels !== undefined && dels > 0 && <span className="text-diff-del">−{dels}</span>}
      {note && <span className="text-faint">{note}</span>}
    </span>
  )
}
