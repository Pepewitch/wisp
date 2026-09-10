import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react"

import { AuthDialog } from "@/components/auth-dialog"
import { ChangesPane } from "@/components/changes-pane"
import { ConnIndicator } from "@/components/conn-indicator"
import { DesktopConnectionChrome } from "@/components/connection-chrome"
import { CreateTaskDialog } from "@/components/create-task-dialog"
import { Conversation } from "@/components/conversation"
import { DesktopZoomControl } from "@/components/desktop-zoom-control"
import { Gallery } from "@/components/gallery"
import { MobileShell } from "@/components/mobile-shell"
import { MobileConnectionStatus } from "@/components/conn-indicator"
import {
  AddProjectDialog,
  ProjectPickerErrorDialog,
} from "@/components/project-add-dialogs"
import { ProjectSettingsDialog } from "@/components/project-settings-dialog"
import { SettingsDialog } from "@/components/settings-dialog"
import { Gear, WispMark } from "@/components/icons"
import { RightColumn, Shell } from "@/components/panes"
import { Button } from "@/components/primitives"
import { Sidebar } from "@/components/sidebar"
import { SteerBox } from "@/components/steer-box"
import { TaskHeader } from "@/components/task-header"
import { TerminalSection } from "@/components/terminal-pane"
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
import { useAddProject } from "@/hooks/mutations"
import { useHashRoute } from "@/hooks/useHashRoute"
import { useProjectSearch } from "@/hooks/useProjectSearch"
import { useSearchShortcuts } from "@/hooks/useSearchShortcuts"
import { useIsMobile } from "@/hooks/useMediaQuery"
import { useLogStream } from "@/hooks/useLogStream"
import { connectionStore } from "@/lib/conn"
import { connectionAttention } from "@/lib/connection-attention"
import {
  readConnectionStorage,
  writeConnectionStorage,
} from "@/lib/connection-storage"
import { classifyConnectionError } from "@/lib/connection-reachability"
import { useDesktopConnections } from "@/lib/desktop-connections"
import { addPickedLocalProject, groupTasksByProject } from "@/lib/projects"
import { queryClient } from "@/lib/query"
import { useDaemonRuntime } from "@/lib/runtime"
import { connectEventsBridge } from "@/lib/sse"
import {
  clearSelectedTask,
  readSelectedTask,
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
    <Gallery />
  ) : (
    <ConnectedApp runtimeKey={runtime.connectionId} />
  )
}

/** Keeps app chrome mounted while MainView resets its connection-owned state. */
function ConnectedApp({ runtimeKey }: { runtimeKey: string }) {
  const updateControls = useWispUpdateControl()
  return <MainView key={runtimeKey} updateControls={updateControls} />
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

function useProjectAddFlow() {
  const desktop = useDesktopConnections()
  const addProject = useAddProject()
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const onAddProject = desktop
    ? () => {
        addProject.reset()
        setPickerError(null)
        // The mutation belongs to the initiating provider. A tab switch can
        // unmount it, but cannot retarget a picker completion to a remote.
        if (desktop.active.metadata.kind === "local") {
          void addPickedLocalProject(
            desktop.pickLocalProject,
            addProject.mutateAsync
          ).catch((error: unknown) =>
            setPickerError(
              error instanceof Error ? error.message : String(error)
            )
          )
          return
        }
        setRemoteOpen(true)
      }
    : undefined
  const dialogs = (
    <>
      <AddProjectDialog
        open={remoteOpen}
        connectionName={desktop?.active.metadata.name ?? ""}
        pending={addProject.isPending}
        error={addProject.error}
        onClose={() => {
          setRemoteOpen(false)
          addProject.reset()
        }}
        onSubmit={async (path) => {
          await addProject.mutateAsync(path)
          setRemoteOpen(false)
        }}
      />
      <ProjectPickerErrorDialog
        error={pickerError}
        onClose={() => setPickerError(null)}
      />
    </>
  )
  return { desktop, onAddProject, pending: addProject.isPending, dialogs }
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
  onReconnect: () => void
) {
  const connection = connectionStore(runtime.connectionId)
  useEffect(
    () =>
      connectEventsBridge({
        client: queryClient,
        transport: runtime.transport,
        qk: runtime.qk,
        getSelectedId: () => selectedRef.current,
        onConnectionChange: (live) => connection.set("events", live),
        onReconnect,
      }),
    [runtime, selectedRef, connection, onReconnect]
  )
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
  const [createFor, setCreateFor] = useState<{
    repoPath: string | null
  } | null>(null)
  const [logGeneration, bumpLogGeneration] = useReducer((n: number) => n + 1, 0)
  // held as a PATH, not a row: the repos query refetches after a save, and a
  // captured row would leave the modal showing what was just replaced
  const [configuringPath, setConfiguringPath] = useState<string | null>(null)
  // Wisp's own preferences: client-local and global, so this belongs to the
  // shell rather than to the selected connection.
  const [settingsOpen, setSettingsOpen] = useState(false)

  const tasksQuery = useTasks(showArchived)
  const statusQuery = useStatus()
  const reposQuery = useRepos()
  const detailQuery = useTaskDetail(selectedId)
  // one record, two surfaces: the sidebar row and the task header can no
  // longer disagree about what a PR has become (see `usePullRequests`)
  const pullRequests = usePullRequests(selectedId)
  const harnessesQuery = useHarnesses(true)

  // ONE EventSource owns Wisp state invalidation. Provider-owned PR status and
  // daemon-cached release status are the only polling exceptions.
  useDaemonEventsBridge(runtime, selectedRef, bumpLogGeneration)

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
    if (tasksQuery.data) {
      if (selectedId && !tasksQuery.data.some((t) => t.id === selectedId))
        selectTask(null)
      else if (!selectedId) {
        const first =
          tasksQuery.data.find((t) => !t.archived) ?? tasksQuery.data[0]
        if (first) selectTask(first.id)
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
    () =>
      groupTasksByProject(
        tasks.filter((t) => !t.archived),
        reposQuery.data ?? []
      ),
    [tasks, reposQuery.data]
  )
  const archivedTasks = useMemo(() => tasks.filter((t) => t.archived), [tasks])

  const sideError = queryError(tasksQuery.error, statusQuery.error)

  const isMobile = useIsMobile()

  // composed once; only one shell mounts, so nothing double-renders
  const sidebarNode = (opts?: {
    touch?: boolean
    afterSelect?: () => void
  }) => (
    <Sidebar
      groups={groups}
      archivedTasks={archivedTasks}
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
      onConfigureProject={(repoPath) => {
        setConfiguringPath(repoPath)
        opts?.afterSelect?.()
      }}
      onOpenSettings={() => {
        // dismiss and open in the same commit — the same pair a project's gear
        // already makes on touch, so the drawer is never left over the modal
        opts?.afterSelect?.()
        setSettingsOpen(true)
      }}
      // below `md` the drawer footer is the only app-chrome surface there is
      updateControl={opts?.touch ? updateControls.mobile : undefined}
      search={projectSearch}
      onAddProject={projectAdd.onAddProject}
      addProjectPending={projectAdd.pending}
      error={sideError}
      loading={tasksQuery.isPending}
      touch={opts?.touch}
    />
  )
  const conversationNode = (
    <Conversation
      task={detailQuery.data ?? null}
      stream={stream}
      note={stream.note}
      touch={isMobile}
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
  const changesNode = (
    <ChangesPane
      taskId={selectedId}
      archived={archived}
      // the base is NOT passed in: only the daemon knows which commit it
      // actually diffed from (it resolves GitHub's base), and a local task
      // diffs against the working tree with no base at all
      onRefresh={() =>
        selectedId &&
        void queryClient.invalidateQueries({
          queryKey: runtime.qk.diff(selectedId),
        })
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
    <>
      <AppDialogs
        createFor={createFor}
        configuringPath={configuringPath}
        repos={reposQuery.data}
        activeTaskCount={groups.find((group) => group.path === configuringPath)?.tasks.length ?? 0}
        harnesses={harnessesQuery.data}
        harnessesError={harnessesQuery.error}
        onCloseCreate={() => setCreateFor(null)}
        onCloseSettings={() => setConfiguringPath(null)}
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
      changes={changesNode}
      terminal={terminalNode}
      composer={composerNode}
      taskHeader={
        <TaskHeader
          task={header}
          pullRequest={pullRequests.selected}
          worktreeReason={detailQuery.data?.worktreeReason ?? null}
        />
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
  changes,
  terminal,
  composer,
  taskHeader,
  updateControl,
  onOpenSettings,
  dialogs,
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
  changes: ReactNode
  terminal: ReactNode
  composer: ReactNode
  taskHeader: ReactNode
  updateControl: ReactNode
  /** The pointer shell's gear. Touch reaches the same modal from the drawer. */
  onOpenSettings: () => void
  dialogs: ReactNode
}) {
  // Below `md`, the three-pane grid is replaced rather than squeezed, so no
  // resizable group applies phone dimensions to desktop geometry.
  if (mobile) {
    return (
      <>
        <MobileShell
          task={task}
          pullRequest={pullRequest}
          sidebar={(dismiss) => sidebar({ touch: true, afterSelect: dismiss })}
          conversation={conversation}
          changes={changes}
          terminal={terminal}
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
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header
        data-tauri-drag-region={desktop ? "" : undefined}
        className={`flex h-9 shrink-0 items-center gap-2.5 border-b border-border bg-surface pr-3 ${desktop ? "pl-20" : "pl-3"}`}
      >
        <span role="img" aria-label="Wisp" className="shrink-0">
          <WispMark className="size-[17px]" />
        </span>
        {desktop && <DesktopConnectionChrome />}
        <span className="flex-1" />
        <span className="ml-1">
          <ConnIndicator />
        </span>
        {/* Everything you can do TO the app is ONE cluster at the right end,
            4px apart against the header's 10px, so the three of them read as a
            group rather than as three unrelated controls that happen to be
            near each other. Updates used to sit at the LEFT end, hard against
            the connection tabs — app news in the corner that answers "which
            daemon am I on", and the only labelled button in a bar of icons.
            The gear stays last: it is still the top-right corner (§5g). */}
        <div className="flex shrink-0 items-center gap-1">
          {updateControl}
          {desktop && <DesktopZoomControl />}
          <Button size="sm" icon aria-label="Settings" onClick={onOpenSettings}>
            <Gear />
          </Button>
        </div>
      </header>

      <Shell
        sidebar={sidebar()}
        centre={
          <main className="flex h-full min-w-0 flex-col bg-background">
            {taskHeader}
            {conversation}
            {composer}
          </main>
        }
        right={<RightColumn changes={changes} terminal={terminal} />}
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
  const features = useHarnessFeatures()
  const harness = task
    ? harnesses?.find((candidate) => candidate.name === task.harness)
    : undefined
  return (
    <SteerBox
      task={task}
      harnesses={harnesses}
      canSwitchAgent={features.data?.taskAgentSwitching === true}
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
  configuringPath,
  repos,
  activeTaskCount,
  harnesses,
  harnessesError,
  onCloseCreate,
  onCloseSettings,
  onCreated,
}: {
  createFor: { repoPath: string | null } | null
  configuringPath: string | null
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
        project={repos?.find((repo) => repo.path === configuringPath) ?? null}
        activeTaskCount={activeTaskCount}
        onOpenChange={(open) => !open && onCloseSettings()}
      />
      <AuthDialog />
    </>
  )
}
