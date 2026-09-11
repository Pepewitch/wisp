import { useHarnesses, useRepos } from "@/hooks/queries"
import { useReprobeHarnesses } from "@/hooks/mutations"
import type { DesktopConnectionMetadata } from "@/lib/desktop-bridge"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { buildFirstRunSteps, type FirstRunStep } from "@/lib/first-run"
import { queryClient } from "@/lib/query"
import { useDaemonRuntime } from "@/lib/runtime"
import type { RepoInfo } from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"

/**
 * Everything the first-run panel needs, and the two repairs that belong to the
 * same fact it reports.
 *
 * The panel replaces the centre column when a connection has nothing to show
 * yet, and the shell asks for it on TWO conditions, because they are two
 * different silences: the tasks list ANSWERED and is empty (a daemon that is
 * working and has not been given anything to do), or `blocked` — Desktop's
 * Local is not set up, where nothing answers at all and the walls today are a
 * tooltip on a 12px glyph and a red string. An unreachable REMOTE tab is
 * deliberately neither: the sidebar's error row and the connection dialogs
 * already own that, and "0 projects" about a daemon nobody asked would be a
 * lie. Nothing here is persisted on either side — archive every task and the
 * panel comes back, correctly.
 *
 * It re-reads `useHarnesses`/`useRepos` rather than taking them as arguments:
 * both are already in flight for the composer and the sidebar, react-query
 * dedupes them by key, and passing four queries down through the shell would
 * have made the panel's data someone else's problem to keep correct.
 */
export interface FirstRunPanel {
  /** Whether the panel should replace the centre column at all. */
  readonly show: boolean
  readonly steps: readonly FirstRunStep[]
  readonly baseLabel: string | null
  /** A task needs a project to live in; without one the button has nowhere to go. */
  readonly canCreateTask: boolean
  /**
   * The sidebar error row's one action. A stopped local daemon does not need
   * another try, it needs setting up; anything else does need another try. One
   * action either way — an 11.5px error row is not the place for a choice.
   */
  errorAction(
    error: string | null
  ): { label: string; onClick: () => void } | undefined
}

/**
 * The one sentence the ready panel can honestly put after "its own branch and
 * worktree": a project's configured base. `""` means "let Wisp resolve the
 * remote default", which is not a branch NAME, so it yields nothing rather
 * than an invented `main`. More than one project has no single answer either.
 */
function soleBaseLabel(repos: RepoInfo[] | undefined): string | null {
  if (!repos || repos.length !== 1) return null
  const base = repos[0]!.baseBranch.trim()
  return base === "" ? null : base
}

function localConnection(
  desktop: ReturnType<typeof useDesktopConnections>
): DesktopConnectionMetadata | null {
  const active = desktop?.active.metadata
  return active && active.kind === "local" ? active : null
}

export function useFirstRunPanel(input: {
  onAddProject: () => void
  pending: boolean
  /** `undefined` while the tasks query is in flight — silence is not an answer. */
  taskCount: number | undefined
}): FirstRunPanel {
  const runtime = useDaemonRuntime()
  const desktop = useDesktopConnections()
  const harnessesQuery = useHarnesses(true)
  const reposQuery = useRepos()
  const reprobe = useReprobeHarnesses()

  const local = localConnection(desktop)
  const blocked = local !== null && !local.ready
  const openLocalSetup = () =>
    uiIntentsFor(runtime.connectionId).openLocalSetup()

  const steps = buildFirstRunSteps(
    {
      // The browser owns one daemon and it served this page, so it has no
      // "is Wisp running" row to render at all.
      daemon: local
        ? {
            ready: local.ready,
            problem: local.problem ?? null,
            summary: local.url ? `${local.name} · ${local.url}` : local.name,
          }
        : null,
      harnesses: harnessesQuery.data,
      harnessesError:
        harnessesQuery.error instanceof Error
          ? harnessesQuery.error.message
          : null,
      projectCount: reposQuery.data?.length,
    },
    {
      onSetUpDaemon: openLocalSetup,
      onRecheckHarnesses: () => reprobe.mutate(),
      recheckPending: reprobe.isPending,
      onAddProject: input.onAddProject,
      addProjectPending: input.pending,
    }
  )

  const projectCount = reposQuery.data?.length ?? 0
  return {
    show: blocked || input.taskCount === 0,
    steps,
    baseLabel: soleBaseLabel(reposQuery.data),
    canCreateTask: projectCount > 0,
    errorAction(error) {
      if (blocked) return { label: "Set up", onClick: openLocalSetup }
      if (!error) return undefined
      return {
        label: "Retry",
        onClick: () => {
          void queryClient.invalidateQueries({ queryKey: runtime.qk.tasks })
          void queryClient.invalidateQueries({ queryKey: runtime.qk.status })
        },
      }
    },
  }
}
