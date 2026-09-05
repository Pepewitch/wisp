import { useEffect, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"

import { Button, Eyebrow, POPOVER_SURFACE } from "@/components/primitives"
import { useCopyPreview, useSaveProject } from "@/hooks/mutations"
import { ApiError, failureReason } from "@/lib/api"
import type { RepoInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Per-project settings: the two worktree hooks and the file-copy patterns.
 *
 * Everything here applies to WORKTREE tasks only, and the modal says so once
 * at the top rather than three times. A local task runs in the checkout the
 * user is already working in, so running a setup script over it (where
 * `pnpm install` and `rm -rf node_modules` live) would be destructive.
 *
 * Saving sends only what this modal owns. The API treats every field as a
 * patch, so the project's display name — which this modal does not edit — is
 * preserved rather than blanked.
 */
export function ProjectSettingsDialog({
  project,
  onOpenChange,
}: {
  /** null closes the dialog; a repo opens it seeded from that repo's config */
  project: RepoInfo | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog.Root open={project !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-(--z-backdrop) bg-black/60" />
        <ProjectSettingsPopup project={project} onClose={() => onOpenChange(false)} />
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * The popup is separate from the modal chrome so the gallery can reuse the
 * same form inside a static surface without invoking dialog focus behavior.
 */
export function ProjectSettingsPopup({
  project,
  onClose,
  className,
}: {
  project: RepoInfo | null
  onClose: () => void
  className?: string
}) {
  return (
    <Dialog.Popup
      className={cn(
        "fixed top-[8vh] left-1/2 z-(--z-modal) w-[min(720px,calc(100vw-3rem))] -translate-x-1/2",
        POPOVER_SURFACE,
        "max-h-[84vh] overflow-hidden rounded-xl shadow-modal outline-none",
        className,
      )}
    >
      {/* keyed on the path so switching projects never shows the last one's scripts */}
      {project && <Form key={project.path} project={project} onClose={onClose} dialog />}
    </Dialog.Popup>
  )
}

export function ProjectSettingsSpecimen({ project }: { project: RepoInfo }) {
  return (
    <div className={cn(POPOVER_SURFACE, "w-full max-w-[720px] overflow-hidden rounded-xl")}>
      <Form project={project} onClose={() => {}} />
    </div>
  )
}

function Form({ project, onClose, dialog = false }: { project: RepoInfo; onClose: () => void; dialog?: boolean }) {
  const [setupScript, setSetupScript] = useState(project.setupScript)
  const [archiveScript, setArchiveScript] = useState(project.archiveScript)
  const [copyText, setCopyText] = useState(project.copyFiles.join("\n"))

  const saveProject = useSaveProject()
  const error = saveProject.error ? failureReason(saveProject.error) : null

  const patterns = copyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

  const save = () => {
    saveProject.mutate(
      { path: project.path, setupScript, archiveScript, copyFiles: patterns },
      { onSuccess: onClose },
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      className={cn("flex flex-col", dialog && "max-h-[84vh]")}
    >
      <div className="flex shrink-0 items-baseline gap-2.5 border-b border-border px-4 py-3">
        {dialog ? (
          <Dialog.Title className="text-[14.5px] font-semibold tracking-[-0.01em]">{project.name}</Dialog.Title>
        ) : (
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em]">{project.name}</h2>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">{project.path}</span>
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          These run for <span className="text-foreground">worktree</span> tasks only. A local task works in this
          directory as it already is, so Wisp neither sets it up nor tears it down.
        </p>

        <Section
          label="Setup script"
          hint="Runs in each new worktree, after the files below are copied in. A repo's own .wisp/setup.sh runs first."
        >
          <ScriptBox
            value={setupScript}
            onChange={setSetupScript}
            placeholder={"pnpm install\npnpm build"}
            aria-label="Setup script"
          />
        </Section>

        <Section label="Archive script" hint="Runs in the worktree just before archiving removes it.">
          <ScriptBox
            value={archiveScript}
            onChange={setArchiveScript}
            placeholder={'find . -name node_modules -type d -prune -exec rm -rf {} +'}
            aria-label="Archive script"
          />
        </Section>

        <Section
          label="Files to copy"
          hint="Untracked files carried into each new worktree — the .env problem. One pattern per line; a pattern with no / matches at any depth."
        >
          <ScriptBox value={copyText} onChange={setCopyText} placeholder=".env*" aria-label="Files to copy" rows={3} />
          <CopyPreview path={project.path} patterns={patterns} />
        </Section>
      </div>

      {error && <div className="shrink-0 px-4 pb-1 text-[11.5px] text-destructive">{error}</div>}

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button type="button" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="lg" tone="primary" disabled={saveProject.isPending}>
          {saveProject.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  )
}

function Section({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 border-t border-border pt-3.5 first-of-type:mt-3.5">
      <Eyebrow>{label}</Eyebrow>
      <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function ScriptBox({
  value,
  onChange,
  placeholder,
  rows = 5,
  "aria-label": ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  rows?: number
  "aria-label": string
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={cn(
        "scroll-slim w-full resize-y rounded-md border border-input bg-surface px-2.5 py-2",
        "font-mono text-[11.5px] leading-[1.75] text-foreground placeholder:text-faint",
        "focus:border-accent-dim focus:ring-2 focus:ring-ring/15 focus:outline-none",
      )}
    />
  )
}

/**
 * What the patterns actually match, resolved by the daemon against the real
 * repo. A glob is only trustworthy once you have seen what it takes, and the
 * failure mode without this is silent: a worktree missing the one .env nobody
 * checked for.
 */
function CopyPreview({ path, patterns }: { path: string; patterns: string[] }) {
  const preview = useCopyPreview()
  const key = patterns.join("\n")

  useEffect(() => {
    if (patterns.length === 0) return
    // typing a glob produces many intermediate patterns that each match half
    // the repo; debounce so only the one they stopped on hits the daemon
    const timer = setTimeout(() => preview.mutate({ path, patterns }), 400)
    return () => clearTimeout(timer)
    // `key` stands in for the pattern list: a new array each render would loop
  }, [path, key]) // eslint-disable-line react-hooks/exhaustive-deps

  if (patterns.length === 0) return null

  // The answer on hand belongs to the patterns it was ASKED for. While the
  // debounce runs, that is the previous glob's file list — showing it reads as
  // "these are your matches" when they are the last ones'.
  const current = preview.variables?.path === path && preview.variables.patterns.join("\n") === key
  const checking = <p className="mt-1.5 text-[11px] text-faint">Checking…</p>
  if (!current || preview.isPending) return checking
  if (preview.error) {
    return (
      <p className="mt-1.5 text-[11px] text-destructive">
        {preview.error instanceof ApiError ? preview.error.message : "preview unavailable"}
      </p>
    )
  }
  const result = preview.data
  if (!result) return checking

  return (
    <div className="mt-1.5">
      <p className="text-[11px] text-muted-foreground">
        {result.files.length === 0
          ? "Nothing matches yet — no files would be copied."
          : `${result.files.length} file${result.files.length === 1 ? "" : "s"} will be copied`}
        {result.truncated && <span className="text-faint"> · capped, narrow the pattern</span>}
      </p>
      {result.files.length > 0 && (
        <div className="scroll-slim mt-1 max-h-28 overflow-y-auto rounded-md border border-border bg-surface px-2.5 py-1.5">
          {result.files.map((file) => (
            <div key={file} className="truncate font-mono text-[11px] text-fg-secondary">
              {file}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
