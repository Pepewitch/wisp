import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react"

import { AuthDialog } from "@/components/auth-dialog"
import { ChangesPane } from "@/components/changes-pane"
import { ConnIndicator } from "@/components/conn-indicator"
import { CreateTaskDialog } from "@/components/create-task-dialog"
import { Conversation } from "@/components/conversation"
import { Gallery } from "@/components/gallery"
import { MobileShell } from "@/components/mobile-shell"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { WispMark } from "@/components/icons"
import { RightColumn, Shell } from "@/components/panes"
import { Sidebar } from "@/components/sidebar"
import { SteerBox } from "@/components/steer-box"
import { TaskHeader } from "@/components/task-header"
import { TerminalSection } from "@/components/terminal-pane"
import { WispUpdateControl } from "@/components/update-control"
import {
  useHarnesses,
  usePullRequestOverview,
  usePullRequestStatus,
  useRepos,
  useStatus,
  useTaskDetail,
  useTaskSkills,
  useTasks,
  useUpdateStatus,
} from "@/hooks/queries"
import { useInstallUpdate } from "@/hooks/mutations"
import { useHashRoute } from "@/hooks/useHashRoute"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useLogStream } from "@/hooks/useLogStream"
import { connectionStore } from "@/lib/conn"
import { readConnectionStorage, writeConnectionStorage } from "@/lib/connection-storage"
import { groupTasksByProject } from "@/lib/projects"
import { queryClient } from "@/lib/query"
import { useDaemonRuntime } from "@/lib/runtime"
import { connectEventsBridge } from "@/lib/sse"
import type { ApiTask, HarnessInfo, RepoInfo, StatusEntry, TaskSkills, Turn } from "@/lib/types"
import { waitForUpdatedDaemon } from "@/lib/update"

const SHOW_ARCHIVED_KEY = "wisp_show_archived"
const SHOW_ARCHIVED_SETTING = "show_archived"

export default function App() {
  const runtime = useDaemonRuntime()
  const route = useHashRoute()
  return route === "/gallery" ? <Gallery /> : <MainView key={runtime.connectionId} />
}

function MainView() {
  const runtime = useDaemonRuntime()
  const conn = connectionStore(runtime.connectionId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  const [showArchived, setShowArchived] = useState(
    () => readConnectionStorage(runtime.connectionId, SHOW_ARCHIVED_SETTING, SHOW_ARCHIVED_KEY) === "1",
  )
  // open state carries the project the sidebar's `+` preselected
  const [createFor, setCreateFor] = useState<{ repoPath: string | null } | null>(null)
  const [logGeneration, bumpLogGeneration] = useReducer((n: number) => n + 1, 0)
  // held as a PATH, not a row: the repos query refetches after a save, and a
  // captured row would leave the modal showing what was just replaced
  const [configuringPath, setConfiguringPath] = useState<string | null>(null)

  const tasksQuery = useTasks(showArchived)
  const statusQuery = useStatus()
  const reposQuery = useRepos()
  const detailQuery = useTaskDetail(selectedId)
  const pullRequestQuery = usePullRequestStatus(selectedId)
  const pullRequestOverviewQuery = usePullRequestOverview()
  const harnessesQuery = useHarnesses(true)
  const updateQuery = useUpdateStatus()
  const installUpdate = useInstallUpdate()
  const [updateError, setUpdateError] = useState<string | null>(null)

  const updateWisp = async (version: string) => {
    setUpdateError(null)
    try {
      await installUpdate.mutateAsync(version)
      await waitForUpdatedDaemon(version, { transport: runtime.transport })
      await runtime.recoverAfterUpdate()
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error))
      void queryClient.invalidateQueries({ queryKey: runtime.qk.update })
    }
  }

  // ONE EventSource owns Wisp state invalidation. Provider-owned PR status and
  // daemon-cached release status are the only polling exceptions.
  useEffect(
    () =>
      connectEventsBridge({
        client: queryClient,
        transport: runtime.transport,
        qk: runtime.qk,
        getSelectedId: () => selectedRef.current,
        onConnectionChange: (live) => conn.set("events", live),
        onReconnect: bumpLogGeneration,
      }),
    [runtime, conn],
  )

  // a fresh [] every render would re-run every memo below it
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data])

  // keep a valid selection across refetches without fighting the user
  const [seen, setSeen] = useState<{ data: typeof tasksQuery.data; id: string | null }>({ data: undefined, id: null })
  if (seen.data !== tasksQuery.data || seen.id !== selectedId) {
    setSeen({ data: tasksQuery.data, id: selectedId })
    if (tasksQuery.data) {
      if (selectedId && !tasksQuery.data.some((t) => t.id === selectedId)) setSelectedId(null)
      else if (!selectedId) {
        const first = tasksQuery.data.find((t) => !t.archived) ?? tasksQuery.data[0]
        if (first) setSelectedId(first.id)
      }
    }
  }

  const task = tasks.find((t) => t.id === selectedId) ?? null
  // the detail row wins once loaded — it carries the turns
  const header = detailQuery.data ?? task
  const archived = task?.archived ?? false
  const status = task ? statusQuery.data?.[task.id] : undefined
  const stream = useLogStream(selectedId, "activity", logGeneration)
  // the harness's own skill registry for Tier 3 (A4) — absent while the
  // daemon can't answer (a running turn), never faked
  const skillsQuery = useTaskSkills(selectedId, archived)

  const groups = useMemo(
    () => groupTasksByProject(tasks.filter((t) => !t.archived), reposQuery.data ?? []),
    [tasks, reposQuery.data],
  )
  const archivedTasks = useMemo(() => tasks.filter((t) => t.archived), [tasks])

  const sideError = queryError(tasksQuery.error, statusQuery.error)

  const isMobile = useIsMobile()

  // composed once; only one shell mounts, so nothing double-renders
  const sidebarNode = (opts?: { touch?: boolean; afterSelect?: () => void }) => (
    <Sidebar
      groups={groups}
      archivedTasks={archivedTasks}
      status={statusQuery.data ?? {}}
      pullRequests={pullRequestOverviewQuery.data?.tasks ?? {}}
      selectedId={selectedId}
      onSelect={(id) => {
        setSelectedId(id)
        opts?.afterSelect?.()
      }}
      showArchived={showArchived}
      onShowArchivedChange={(v) => {
        writeConnectionStorage(
          runtime.connectionId,
          SHOW_ARCHIVED_SETTING,
          SHOW_ARCHIVED_KEY,
          v ? "1" : "0",
        )
        setShowArchived(v)
      }}
      onNewTask={(repoPath) => {
        setCreateFor({ repoPath })
        opts?.afterSelect?.()
      }}
      onConfigureProject={(repoPath) => {
        setConfiguringPath(repoPath)
        opts?.afterSelect?.()
      }}
      error={sideError}
      loading={tasksQuery.isPending}
      touch={opts?.touch}
    />
  )
  const conversationNode = <Conversation task={detailQuery.data ?? null} stream={stream} note={stream.note} />
  const composerNode = (
    <TaskComposer
      task={header}
      harnesses={harnessesQuery.data}
      skills={skillsQuery.data}
      status={status}
      turns={detailQuery.data?.turns}
      touch={isMobile}
    />
  )
  const changesNode = (
    <ChangesPane
      taskId={selectedId}
      archived={archived}
      // the base is NOT passed in: only the daemon knows which commit it
      // actually diffed from (it resolves GitHub's base), and a local task
      // diffs against the working tree with no base at all
      onRefresh={() =>
        selectedId && void queryClient.invalidateQueries({ queryKey: runtime.qk.diff(selectedId) })
      }
    />
  )
  const terminalNode = (
    <TerminalSection
      taskId={selectedId}
      // the list row is what the SSE bridge refreshes; a just-created task has
      // no worktree yet, so the pane waits instead of failing to connect
      worktreePath={task?.worktree_path ?? null}
      archived={archived}
      touch={isMobile}
    />
  )
  const dialogs = (
    <AppDialogs
      createFor={createFor}
      configuringPath={configuringPath}
      repos={reposQuery.data}
      harnesses={harnessesQuery.data}
      harnessesError={harnessesQuery.error}
      onCloseCreate={() => setCreateFor(null)}
      onCloseSettings={() => setConfiguringPath(null)}
      onCreated={setSelectedId}
    />
  )

  // below `md` the three-pane grid is REPLACED, not squeezed. The resizable
  // groups never mount there, so desktop geometry is neither applied nor
  // overwritten by phone dimensions (useMediaQuery.ts).
  if (isMobile) {
    return (
      <>
        <MobileShell
          task={header}
          pullRequest={pullRequestQuery.data}
          sidebar={(dismiss) => sidebarNode({ touch: true, afterSelect: dismiss })}
          conversation={conversationNode}
          changes={changesNode}
          terminal={terminalNode}
          composer={composerNode}
        />
        {dialogs}
      </>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex h-9 shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3">
        <WispMark className="size-[17px]" />
        <span className="text-[13px] font-semibold tracking-[-0.005em]">Wisp</span>
        <WispUpdateControl
          status={updateQuery.data}
          updating={installUpdate.isPending}
          error={updateError}
          onUpdate={(version) => void updateWisp(version)}
        />
        <span className="flex-1" />
        <span className="ml-1">
          <ConnIndicator />
        </span>
      </header>

      <Shell
        sidebar={sidebarNode()}
        centre={
          <main className="flex h-full min-w-0 flex-col bg-background">
            <TaskHeader
              task={header}
              pullRequest={pullRequestQuery.data}
              // only the detail route carries it; the list row does not
              worktreeReason={detailQuery.data?.worktreeReason ?? null}
            />
            {conversationNode}
            {composerNode}
          </main>
        }
        right={<RightColumn changes={changesNode} terminal={terminalNode} />}
      />

      {dialogs}
    </div>
  )
}

function queryError(tasksError: unknown, statusError: unknown): string | null {
  if (tasksError instanceof Error) return `tasks: ${tasksError.message}`
  if (statusError instanceof Error) return `status: ${statusError.message}`
  return null
}

function TaskComposer({
  task,
  harnesses,
  skills,
  status,
  turns,
  touch,
}: {
  task: ApiTask | null
  harnesses: HarnessInfo[] | undefined
  skills: TaskSkills | undefined
  status: StatusEntry | undefined
  turns: Turn[] | undefined
  touch: boolean
}) {
  const harness = task ? harnesses?.find((candidate) => candidate.name === task.harness) : undefined
  return (
    <SteerBox
      task={task}
      hasImage={harness?.hasImage}
      imageNote={harness?.imageNote}
      probeCommands={harness?.probeCommands}
      skills={skills}
      compact={harness?.compact}
      status={status}
      turns={turns}
      runningSince={turns?.find((turn) => turn.status === "running")?.started_at ?? null}
      touch={touch}
    />
  )
}

function AppDialogs({
  createFor,
  configuringPath,
  repos,
  harnesses,
  harnessesError,
  onCloseCreate,
  onCloseSettings,
  onCreated,
}: {
  createFor: { repoPath: string | null } | null
  configuringPath: string | null
  repos: RepoInfo[] | undefined
  harnesses: HarnessInfo[] | undefined
  harnessesError: unknown
  onCloseCreate: () => void
  onCloseSettings: () => void
  onCreated: (id: string) => void
}) {
  return (
    <>
      <CreateTaskDialog
        open={createFor !== null}
        onOpenChange={(open) => !open && onCloseCreate()}
        initialRepoPath={createFor?.repoPath ?? null}
        repos={repos}
        harnesses={harnesses}
        harnessesError={harnessesError instanceof Error ? harnessesError.message : null}
        onCreated={onCreated}
      />
      <ProjectSettingsDialog
        project={repos?.find((repo) => repo.path === configuringPath) ?? null}
        onOpenChange={(open) => !open && onCloseSettings()}
      />
      <AuthDialog />
    </>
  )
}
