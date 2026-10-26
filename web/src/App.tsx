import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react"

import { AuthDialog } from "@/components/auth-dialog"
import { DesktopConnectionChrome } from "@/components/connection-chrome"
import { CreateTaskDialog } from "@/components/create-task-dialog"
import { Conversation } from "@/components/conversation"
import { DesktopZoomControl } from "@/components/desktop-zoom-control"
import { PaneErrorBoundary } from "@/components/error-boundary"
import { LazyGallery } from "@/components/lazy-gallery"
import { MobileShell } from "@/components/mobile-shell"
import { MobileConnectionStatus } from "@/components/conn-indicator"
import { ProjectSettingsDialog, type ProjectSettingsTarget } from "@/components/project-settings-dialog"
import { SettingsDialog } from "@/components/settings-dialog"
import { UsageLimitsControl } from "@/components/usage-limits-control"
import { StartHere } from "@/components/start-here"
import { Shell, ToolPanel } from "@/components/panes"
import { Sidebar } from "@/components/sidebar"
import { SteerBox } from "@/components/steer-box"
import { TaskNotices } from "@/components/task-notices"
import { TopBar } from "@/components/top-bar"
import { headerTask } from "@/lib/header-task"
import { buildTaskSurfaces, type TaskSurfaces } from "@/components/task-surfaces"
import {
  useHarnesses,
  useHarnessFeatures,
  usePullRequests,
  useRepos,
  useStatus,
  useTaskDetail,
  useTaskSkills,
  useTasks,
} from "@/hooks/queries"
import { useFirstRunPanel } from "@/hooks/useFirstRunPanel"
import { useProjectAddFlow } from "@/hooks/useProjectAddFlow"
import { useHashRoute } from "@/hooks/useHashRoute"
import { useProjectSearch } from "@/hooks/useProjectSearch"
import { useSearchShortcuts } from "@/hooks/useSearchShortcuts"
import { useTaskSwitchPerformance } from "@/hooks/useTaskSwitchPerformance"
import { useDesktopTaskNavigation } from "@/hooks/useDesktopTaskNavigation"
import { useSidebarTree } from "@/hooks/useSidebarTree"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useLogStream } from "@/hooks/useLogStream"
import { ToolPanelContext, useTaskToolPanel, type ToolPanelControls } from "@/hooks/useToolPanel"
import { connectionStore } from "@/lib/conn"
import { connectionAttention } from "@/lib/connection-attention"
import {
  readConnectionStorage,
  writeConnectionStorage,
} from "@/lib/connection-storage"
import { classifyConnectionError } from "@/lib/connection-reachability"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { preloadProseHighlighter } from "@/lib/prose-highlight"
import { queryClient } from "@/lib/query"
import { useDaemonRuntime } from "@/lib/runtime"
import { connectEventsBridge } from "@/lib/sse"
import {
  clearSelectedTask,
  readSelectedTask,
  reconcileSelectedTaskId,
  writeSelectedTask,
} from "@/lib/task-selection"
import type {
  ApiTask,
  HarnessInfo,
  PullRequestStatus,
  RepoInfo,
  StatusEntry,
  TaskSkills,
  Turn,
} from "@/lib/types"
import { uiIntentsFor } from "@/lib/ui-intents"
import { useWispUpdateControl } from "@/lib/use-wisp-update-control"

const SHOW_ARCHIVED_KEY = "wisp_show_archived"
const SHOW_ARCHIVED_SETTING = "show_archived"

export default function App() {
  const runtime = useDaemonRuntime()
  const route = useHashRoute()
  return route === "/gallery" ? (
    <LazyGallery />
  ) : (
    <ConnectedApp runtimeKey={runtime.connectionId} />
  )
}

/** Keeps app chrome mounted while MainView resets its connection-owned state. */
function ConnectedApp({ runtimeKey }: { runtimeKey: string }) {
  const updateControls = useWispUpdateControl()
  return (
    <>
      <MainView key={runtimeKey} updateControls={updateControls} />
      {updateControls.dialog}
    </>
  )
}

type LiveConversationProps = Omit<ComponentProps<typeof Conversation>, "stream" | "note"> & {
  taskId: string | null
  generation: number
}

/** The log follow lives down here, so a frame re-renders the transcript and not the app shell. */
function LiveConversation({ taskId, generation, ...props }: LiveConversationProps) {
  const stream = useLogStream(taskId, "activity", generation)
  // Ask for the lazily loaded highlighter with the task rather than with its
  // first fence, so it is normally here before the transcript is.
  useEffect(() => void (taskId !== null && preloadProseHighlighter()), [taskId])
  return (
    // Keyed by task: a bad turn in one task must not leave the next task's
    // conversation stuck showing the previous one's fallback.
    <PaneErrorBoundary key={taskId ?? "none"} label="the conversation">
      <Conversation {...props} stream={stream} note={stream.note} />
    </PaneErrorBoundary>
  )
}

function useConnectionTaskSelection(connectionId: string) {
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readSelectedTask(connectionId)
  )
  const selectTask = useCallback(
    (id: string | null) => {
      if (id === null) clearSelectedTask(connectionId)
      else writeSelectedTask(connectionId, id)
      setSelectedId(id)
    },
    [connectionId]
  )
  // A clicked desktop notification for THIS connection arrives while the view
  // is mounted, so storage alone would not move it. Requests older than the
  // mount are history: the seed captures the current sequence number.
  const intents = uiIntentsFor(connectionId)
  const focusRequest = useSyncExternalStore(
    intents.subscribe,
    intents.taskFocusRequest
  )
  const answeredSeq = useRef(focusRequest?.seq ?? 0)
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === answeredSeq.current) return
    answeredSeq.current = focusRequest.seq
    selectTask(focusRequest.taskId)
  }, [focusRequest, selectTask])
  return [selectedId, selectTask] as const
}

function useDesktopConnectionHealth(
  connectionId: string,
  tasks: readonly ApiTask[],
  loaded: boolean,
  error: unknown
) {
  const desktop = useDesktopConnections()
  const reportAttention = desktop?.reportAttention
  useEffect(() => {
    reportAttention?.(connectionId, connectionAttention(tasks))
  }, [connectionId, reportAttention, tasks])
  const observeTaskStates = desktop?.observeTaskStates
  useEffect(() => {
    // the empty list before the first answer is not an observation
    if (loaded) observeTaskStates?.(connectionId, tasks)
  }, [connectionId, loaded, observeTaskStates, tasks])
  const reportReachability = desktop?.reportReachability
  useEffect(() => {
    if (!reportReachability) return
    if (error) reportReachability(connectionId, classifyConnectionError(error))
    else if (loaded) reportReachability(connectionId, "online")
  }, [connectionId, error, loaded, reportReachability])
}

function useDaemonEventsBridge(
  runtime: ReturnType<typeof useDaemonRuntime>,
  selectedRef: RefObject<string | null>,
  onReconnect: () => void,
  reconnectRequests: number
) {
  const connection = connectionStore(runtime.connectionId)
  useEffect(() => {
    connection.opening("events")
    return connectEventsBridge({
      client: queryClient,
      transport: runtime.transport,
      qk: runtime.qk,
      getSelectedId: () => selectedRef.current,
      onConnectionChange: (live) => connection.set("events", live),
      onReconnect,
    })
  }, [runtime, selectedRef, connection, onReconnect, reconnectRequests])
}

function useReconnectRequests(connectionId: string): number {
  const intents = uiIntentsFor(connectionId)
  return useSyncExternalStore(intents.subscribe, intents.reconnectRequests)
}

/** Archived history is a per-connection preference, so it is stored per connection. */
function useShowArchived(connectionId: string): readonly [boolean, (value: boolean) => void] {
  const [showArchived, setShowArchived] = useState(
    () =>
      readConnectionStorage(connectionId, SHOW_ARCHIVED_SETTING, SHOW_ARCHIVED_KEY) === "1"
  )
  return [
    showArchived,
    (value: boolean) => {
      writeConnectionStorage(
        connectionId,
        SHOW_ARCHIVED_SETTING,
        SHOW_ARCHIVED_KEY,
        value ? "1" : "0"
      )
      setShowArchived(value)
    },
  ] as const
}

function MainView({
  updateControls,
}: {
  updateControls: { desktop: ReactNode; mobile: ReactNode }
}) {
  const runtime = useDaemonRuntime()
  const projectAdd = useProjectAddFlow()
  const desktop = projectAdd.desktop
  const [selectedId, selectTask] = useConnectionTaskSelection(
    runtime.connectionId
  )
  const selectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  const searchFeature = useHarnessFeatures()
  const [showArchived, setShowArchived] = useShowArchived(runtime.connectionId)
  // search can find an archived task whatever the switch says; the switch
  // decides whether the pane shows the row (and whether ↑/↓ can reach it)
  // A daemon that predates cross-task search omits the flag, and absent reads
  // as unsupported (types.ts) rather than as a switch that quietly 404s.
  const projectSearch = useProjectSearch(
    showArchived,
    searchFeature.data?.taskSearch === true
  )
  useSearchShortcuts(uiIntentsFor(runtime.connectionId), projectSearch)
  // open state carries the project the sidebar's `+` preselected
  const [createFor, setCreateFor] = useState<{ repoPath: string | null } | null>(null)
  const [logGeneration, bumpLogGeneration] = useReducer((n: number) => n + 1, 0)
  const reconnectRequests = useReconnectRequests(runtime.connectionId)
  // held as a PATH, not a row: the repos query refetches after a save, and a
  // captured row would leave the modal showing what was just replaced; plus
  // the section it opens at (the sidebar's verification control's)
  const [configuring, setConfiguring] = useState<ProjectSettingsTarget | null>(null)
  // Wisp's own preferences are client-local and global (§5g), so they belong
  // to the shell rather than to the selected connection.
  const [settingsOpen, setSettingsOpen] = useState(false)

  const tasksQuery = useTasks(showArchived)
  const statusQuery = useStatus(selectedId)
  const reposQuery = useRepos()
  const detailQuery = useTaskDetail(selectedId)
  useTaskSwitchPerformance(selectedId, detailQuery.data?.id, detailQuery.dataUpdatedAt)
  // one record, two surfaces: the sidebar row and the task header can no
  // longer disagree about what a PR has become (see `usePullRequests`)
  const pullRequests = usePullRequests(selectedId)
  const harnessesQuery = useHarnesses(true)

  // ONE EventSource owns Wisp state invalidation. Provider-owned PR status and
  // daemon-cached release and plan-limit status are the only polling exceptions.
  useDaemonEventsBridge(runtime, selectedRef, bumpLogGeneration, reconnectRequests)

  // a fresh [] every render would re-run every memo below it
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data])
  useDesktopConnectionHealth(
    runtime.connectionId,
    tasks,
    tasksQuery.data !== undefined,
    tasksQuery.error
  )

  // keep a valid selection across refetches without fighting the user
  const [seen, setSeen] = useState<{
    data: typeof tasksQuery.data
    id: string | null
  }>({ data: undefined, id: null })
  if (seen.data !== tasksQuery.data || seen.id !== selectedId) {
    setSeen({ data: tasksQuery.data, id: selectedId })
    const next = reconcileSelectedTaskId(selectedId, tasksQuery.data, seen.data)
    if (next !== selectedId) selectTask(next)
  }

  const task = tasks.find((t) => t.id === selectedId) ?? null
  // the detail row wins once loaded — it carries the turns; list-only state
  // (auto-merge) rides along from the task row
  const header = headerTask(detailQuery.data, task)
  const archived = task?.archived ?? false
  // Status owns Git health for both sidebar and header. It may arrive after
  // conversation paint, but a slow or failed Git sweep never blocks Chat.
  const status = task ? statusQuery.data?.[task.id] : undefined
  // the harness's own skill registry for Tier 3 (A4) — absent while the
  // daemon can't answer (a running turn), never faked
  const skillsQuery = useTaskSkills(selectedId, archived)

  const { groups, archivedTasks, ...sidebarTree } = useSidebarTree({
    connectionId: runtime.connectionId,
    tasks,
    repos: reposQuery.data,
    nest: searchFeature.data?.subtasks === true,
    selectedId,
  })
  useDesktopTaskNavigation(desktop !== null, sidebarTree.visibleIds, selectedId, selectTask)

  const sideError = queryError(tasksQuery.error, statusQuery.error)

  const firstRun = useFirstRunPanel({
    onAddProject: projectAdd.onAddProject,
    pending: projectAdd.pending,
    taskCount: tasksQuery.data?.length,
  })

  const isMobile = useIsMobile()
  // the phone keeps its own tabs, so the chords are the pointer shell's
  const tools = useTaskToolPanel(runtime.connectionId, selectedId, searchFeature, !isMobile && task !== null)
  // the base is NOT passed to the diff: only the daemon knows which commit it
  // actually diffed from (it resolves GitHub's base), and a local task diffs
  // against the working tree with no base at all
  const refreshDiff = () =>
    selectedId &&
    void queryClient.invalidateQueries({ queryKey: runtime.qk.diff(selectedId) })

  // composed once; only one shell mounts, so nothing double-renders
  const sidebarNode = (opts?: {
    touch?: boolean
    afterSelect?: () => void
  }) => (
    <Sidebar
      groups={groups}
      archivedTasks={archivedTasks}
      tree={sidebarTree}
      status={statusQuery.data ?? {}}
      pullRequests={pullRequests.tasks}
      selectedId={selectedId}
      onSelect={(id) => {
        selectTask(id)
        opts?.afterSelect?.()
      }}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      onNewTask={(repoPath) => {
        setCreateFor({ repoPath })
        opts?.afterSelect?.()
      }}
      onConfigureProject={(repoPath, section) => {
        setConfiguring({ path: repoPath, section: section ?? null })
        opts?.afterSelect?.()
      }}
      verification={searchFeature.data?.autoReview === true}
      onOpenSettings={() => {
        // dismiss and open in the same commit — the same pair a project's gear
        // already makes on touch, so the drawer is never left over the modal
        opts?.afterSelect?.()
        setSettingsOpen(true)
      }}
      // below `md` the drawer footer is the only app-chrome surface there is
      updateControl={opts?.touch ? updateControls.mobile : undefined}
      usageControl={opts?.touch ? (open) => <UsageLimitsControl mobile harness={header?.harness ?? null} onOpenSettings={open} /> : undefined}
      search={projectSearch}
      onAddProject={projectAdd.onAddProject}
      addProjectPending={projectAdd.pending}
      error={sideError}
      errorAction={firstRun.errorAction(sideError)}
      loading={tasksQuery.isPending}
      touch={opts?.touch}
    />
  )
  const conversationNode = (
    <LiveConversation
      taskId={selectedId}
      generation={logGeneration + reconnectRequests}
      task={detailQuery.data ?? null}
      touch={isMobile}
      hasOlderTurns={detailQuery.hasOlderTurns}
      isLoadingOlderTurns={detailQuery.isLoadingOlderTurns}
      olderTurnsError={detailQuery.olderTurnsError}
      onLoadOlderTurns={detailQuery.loadOlderTurns}
    />
  )
  const composerNode = (
    <TaskComposer
      key={`${runtime.connectionId}:${header?.id ?? ""}`}
      task={header}
      harnesses={harnessesQuery.data}
      skills={skillsQuery.data}
      status={status}
      turns={detailQuery.data?.turns}
      touch={isMobile}
    />
  )
  const taskSurfaces = buildTaskSurfaces({
    mobile: isMobile,
    features: searchFeature.data,
    connectionId: runtime.connectionId,
    // the header's row: it carries the autopilot status, and the list row alone can lag the detail
    task: header,
    taskId: selectedId,
    archived,
    onRefresh: refreshDiff,
    tools,
  })
  // Replaces the whole centre column — including the "Select a task" band,
  // which had nothing to select and said so over a panel already saying it.
  const firstRunNode = firstRun.show && selectedId === null ? (
    <StartHere
      steps={firstRun.steps}
      baseLabel={firstRun.baseLabel}
      onNewTask={firstRun.canCreateTask ? () => setCreateFor({ repoPath: null }) : undefined}
      touch={isMobile}
    />
  ) : null
  const dialogs = (
    <>
      <AppDialogs
        createFor={createFor}
        configuring={configuring}
        repos={reposQuery.data}
        activeTaskCount={groups.find((g) => g.path === configuring?.path)?.tasks.length ?? 0}
        harnesses={harnessesQuery.data}
        harnessesError={harnessesQuery.error}
        onCloseCreate={() => setCreateFor(null)}
        onCloseSettings={() => setConfiguring(null)}
        onCreated={selectTask}
      />
      {projectAdd.dialogs}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
  return (
    <AppShell
      mobile={isMobile}
      desktop={desktop !== null}
      task={header}
      pullRequest={pullRequests.selected}
      sidebar={sidebarNode}
      conversation={conversationNode}
      surfaces={taskSurfaces}
      tools={tools}
      composer={composerNode}
      firstRun={firstRunNode}
      taskNotices={
        <TaskNotices task={header} worktreeReason={status?.worktreeReason ?? null} />
      }
      updateControl={updateControls.desktop}
      onOpenSettings={() => setSettingsOpen(true)}
      dialogs={dialogs}
    />
  )
}

function AppShell({
  mobile,
  desktop,
  task,
  pullRequest,
  sidebar,
  conversation,
  surfaces,
  tools,
  composer,
  taskNotices,
  updateControl,
  onOpenSettings,
  dialogs,
  firstRun,
}: {
  mobile: boolean
  desktop: boolean
  task: ApiTask | null
  pullRequest?: PullRequestStatus
  sidebar: (options?: {
    touch?: boolean
    afterSelect?: () => void
  }) => ReactNode
  conversation: ReactNode
  /** the task's surfaces beside the conversation (buildTaskSurfaces) */
  surfaces: TaskSurfaces
  /** which tool the pointer shell's panel shows for this task (useToolPanel) */
  tools: ToolPanelControls
  composer: ReactNode
  /** what the task asks you to act on, above its conversation (task-notices.tsx) */
  taskNotices: ReactNode
  updateControl: ReactNode
  /** The pointer shell's gear. Touch reaches the same modal from the drawer. */
  onOpenSettings: () => void
  dialogs: ReactNode
  /** When set, it OWNS the centre column — notices, transcript and composer. */
  firstRun: ReactNode
}) {
  const barRef = useRef<HTMLElement>(null)
  // Below `md`, the three-pane grid is replaced rather than squeezed, so no
  // resizable group applies phone dimensions to desktop geometry.
  if (mobile) {
    return (
      <>
        <MobileShell
          task={task}
          pullRequest={pullRequest}
          firstRun={firstRun}
          sidebar={(dismiss) => sidebar({ touch: true, afterSelect: dismiss })}
          conversation={conversation}
          {...surfaces}
          composer={composer}
          connectionStatus={!desktop ? <MobileConnectionStatus /> : undefined}
          desktop={desktop}
          connectionSwitcher={
            desktop ? <DesktopConnectionChrome mobile /> : undefined
          }
          zoomControl={desktop ? <DesktopZoomControl mobile /> : undefined}
        />
        {dialogs}
      </>
    )
  }

  return (
    // the top bar's icons, the panel and the `/` palette all act on one task's tools
    <ToolPanelContext.Provider value={tools}>
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <TopBar
          barRef={barRef}
          desktop={desktop}
          task={firstRun === null ? task : null}
          pullRequest={pullRequest}
          updateControl={updateControl}
          onOpenSettings={onOpenSettings}
        />

        <Shell
          sidebar={sidebar()}
          // written to the bar's style rather than to state, so a divider drag
          // does not re-render the app on every frame
          onSidebarResize={(px) => barRef.current?.style.setProperty("--sidebar-width", `${px}px`)}
          centre={
            <main className="flex h-full min-w-0 flex-col bg-background">
              {firstRun ?? (
                <>
                  {taskNotices}
                  {conversation}
                  {composer}
                </>
              )}
            </main>
          }
          panel={
            <ToolPanel
              tool={surfaces.changes}
              terminal={surfaces.terminal}
              terminalKey={task?.id ?? ""}
              toolOpen={tools.layout.tool !== null}
              terminalOpen={tools.layout.terminal}
              onCloseTool={() => {
                if (tools.layout.tool) tools.close(tools.layout.tool)
              }}
              onCloseTerminal={() => tools.close("terminal")}
            />
          }
          // the stored layout, not the task row: the row arrives a beat after a
          // reload, and a panel that waited for it would glide open instead of
          // being restored (no task selected means nothing open)
          panelOpen={tools.open}
          onPanelDraggedShut={tools.closePanel}
        />
        {dialogs}
      </div>
    </ToolPanelContext.Provider>
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
  const features = useHarnessFeatures()
  const harness = task
    ? harnesses?.find((candidate) => candidate.name === task.harness)
    : undefined
  return (
    <SteerBox
      task={task}
      harnesses={harnesses}
      canSwitchAgent={features.data?.taskAgentSwitching === true}
      canChooseDelivery={features.data?.steerDelivery === true}
      hasImage={harness?.hasImage}
      imageNote={harness?.imageNote}
      probeCommands={harness?.probeCommands}
      skills={skills}
      compact={harness?.compact}
      status={status}
      turns={turns}
      runningSince={
        turns?.find((turn) => turn.status === "running")?.started_at ?? null
      }
      touch={touch}
    />
  )
}

function AppDialogs({
  createFor,
  configuring,
  repos,
  activeTaskCount,
  harnesses,
  harnessesError,
  onCloseCreate,
  onCloseSettings,
  onCreated,
}: {
  createFor: { repoPath: string | null } | null
  configuring: ProjectSettingsTarget | null
  repos: RepoInfo[] | undefined
  activeTaskCount: number
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
        harnessesError={
          harnessesError instanceof Error ? harnessesError.message : null
        }
        onCreated={onCreated}
      />
      <ProjectSettingsDialog
        project={repos?.find((repo) => repo.path === configuring?.path) ?? null}
        activeTaskCount={activeTaskCount}
        section={configuring?.section}
        onOpenChange={(open) => !open && onCloseSettings()}
      />
      <AuthDialog />
    </>
  )
}
