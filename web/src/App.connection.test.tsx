import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type {
  DesktopBootstrap,
  DesktopBridge,
  DesktopConnectionMetadata,
  DesktopUpdateStatus,
} from "@/lib/desktop-bridge"
import {
  DesktopApplicationProvider,
  useDesktopConnections,
} from "@/lib/desktop-connections"
import { DesktopUpdaterProvider } from "@/lib/desktop-updater"
import { DesktopZoomProvider } from "@/lib/desktop-zoom"
import { DaemonRuntimeProvider } from "@/lib/runtime"
import { useWispUpdateControl } from "@/lib/use-wisp-update-control"
import type { UpdateStatus } from "@/lib/types"
import { fakeDaemonTransport } from "@/test/runtime"

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  refresh: vi.fn(),
  waitForUpdatedDaemon: vi.fn(),
}))
const fixtures = vi.hoisted(() => ({
  tasks: [],
  status: {},
  repos: [],
  harnesses: [],
  pullRequests: { tasks: {} },
}))

const UPDATE: UpdateStatus = {
  currentVersion: "0.4.0-alpha.6",
  latestVersion: "0.4.0-alpha.8",
  currentApiProtocolVersion: 1,
  latestApiProtocolVersion: 1,
  canAutoUpdate: true,
  state: "available",
  installMethod: "homebrew",
  message: null,
  checkedAt: "2026-09-05T08:00:00Z",
}

const LOCAL: DesktopConnectionMetadata = {
  id: "local",
  routeRevision: 0,
  kind: "local",
  name: "Local",
  url: null,
  instanceId: "wisp-instance-local",
  ready: true,
}

const REMOTE: DesktopConnectionMetadata = {
  id: "saved-remote",
  routeRevision: 0,
  kind: "remote",
  name: "Saved remote",
  url: "https://remote.example.test",
  instanceId: "wisp-instance-remote",
  ready: true,
}

const DESKTOP_STATUS: DesktopUpdateStatus = {
  channel: "alpha",
  configured: false,
  currentVersion: "0.4.0-synthetic",
  latestVersion: null,
  phase: "unconfigured",
  releaseNotes: null,
  publishedAt: null,
  checkedAt: null,
  downloadedBytes: 0,
  totalBytes: null,
  message: "Updater is not configured.",
}

function desktopBootstrap(): DesktopBootstrap {
  return {
    connections: [LOCAL, REMOTE],
    activeConnectionId: "local",
    proxyBaseUrl: "http://127.0.0.1:45123/per-launch-capability",
    local: {
      available: true,
      configPath: "/synthetic/.wisp/config.json",
      baseUrl: "http://127.0.0.1:18710",
      instanceId: LOCAL.instanceId,
      hasToken: true,
      reason: null,
    },
  }
}

function desktopBridge(): DesktopBridge {
  const setup = {
    status: desktopBootstrap().local,
    cliPath: "/synthetic/bin/wisp",
    daemonReachable: true,
    nextStep: "ready" as const,
    message: "Local Wisp is ready.",
  }
  return {
    bootstrap: async () => desktopBootstrap(),
    selectConnection: async () => undefined,
    probeRemoteConnection: async () => ({
      instanceId: REMOTE.instanceId,
      apiProtocolVersion: 1,
      version: "0.4.0-synthetic",
    }),
    probeSavedConnection: async () => ({
      instanceId: REMOTE.instanceId,
      apiProtocolVersion: 1,
      version: "0.4.0-synthetic",
    }),
    addRemoteConnection: async () => REMOTE,
    renameConnection: async () => LOCAL,
    reconnectConnection: async () => LOCAL,
    removeConnection: async () => undefined,
    resetDesktopData: async () => undefined,
    saveTaskExport: async () => true,
    pickLocalProject: async () => null,
    setupLocalWisp: async () => setup,
    applyLocalWispSetup: async () => setup,
    openExternalUrl: async () => undefined,
    notifyTaskTransition: async () => undefined,
    onFocusTask: async () => () => undefined,
    desktopUpdateStatus: async () => DESKTOP_STATUS,
    checkDesktopUpdate: async () => DESKTOP_STATUS,
    installDesktopUpdate: async () => DESKTOP_STATUS,
    relaunchDesktop: async () => undefined,
    onDesktopUpdateStatus: async () => () => undefined,
    revealWorktreeFile: async () => undefined,
  }
}

function DesktopUpdateHarness() {
  const desktop = useDesktopConnections()!
  const updates = useWispUpdateControl()
  return (
    <>
      <button
        type="button"
        onClick={() => void desktop.select(REMOTE.id)}
      >
        Select saved remote
      </button>
      <output aria-label="active connection">{desktop.active.metadata.id}</output>
      {updates.desktop}
    </>
  )
}

vi.mock("@/hooks/queries", () => ({
  useTasks: () => ({ data: fixtures.tasks, error: null, isPending: false }),
  useStatus: () => ({ data: fixtures.status, error: null }),
  useRepos: () => ({ data: fixtures.repos }),
  useTaskDetail: () => ({ data: undefined }),
  usePullRequests: () => ({ tasks: fixtures.pullRequests.tasks, selected: undefined }),
  useHarnesses: () => ({ data: fixtures.harnesses, error: null }),
  // the daemon-level flags; `taskSearch` is what puts the sidebar's search
  // control on screen (an older remote omits it)
  useHarnessFeatures: () => ({ data: { taskSearch: true } }),
  useTaskSearch: () => ({ data: undefined, isPending: false, error: null }),
  useUpdateStatus: () => ({ data: UPDATE }),
  useTaskSkills: () => ({ data: undefined }),
  useWispSettings: () => ({
    data: { autoRenameTasksFromPullRequests: true },
    error: null,
  }),
}))

vi.mock("@/hooks/mutations", () => ({
  useInstallUpdate: () => ({ mutateAsync: mocks.install, isPending: false }),
  useRefreshUpdateStatus: () => ({
    mutateAsync: mocks.refresh,
    isPending: false,
  }),
  useAddProject: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
  useUpdateWispSettings: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
  // the first-run panel's "Check again"
  useReprobeHarnesses: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock("@/hooks/useLogStream", () => ({
  useLogStream: () => ({ activity: [], note: null }),
}))

// Desktop's top bar mounts the zoom control, whose provider reaches the
// native webview; the test only needs the call to land somewhere harmless.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: async () => undefined }),
}))

vi.mock("@/hooks/useMediaQuery", () => ({
  useIsMobile: () => false,
}))

vi.mock("@/lib/sse", () => ({
  connectEventsBridge: () => () => undefined,
}))

vi.mock("@/lib/update", () => ({
  waitForUpdatedDaemon: mocks.waitForUpdatedDaemon,
}))

vi.mock("@/components/auth-dialog", () => ({ AuthDialog: () => null }))
vi.mock("@/components/changes-pane", () => ({ ChangesPane: () => null }))
vi.mock("@/components/conn-indicator", () => ({ ConnIndicator: () => null }))
vi.mock("@/components/conversation", () => ({ Conversation: () => null }))
vi.mock("@/components/create-task-dialog", () => ({ CreateTaskDialog: () => null }))
vi.mock("@/components/gallery", () => ({ Gallery: () => null }))
vi.mock("@/components/mobile-shell", () => ({ MobileShell: () => null }))
vi.mock("@/components/panes", () => ({ Shell: () => null, RightColumn: () => null }))
vi.mock("@/components/project-settings-dialog", () => ({ ProjectSettingsDialog: () => null }))
vi.mock("@/components/sidebar", () => ({ Sidebar: () => null }))
vi.mock("@/components/steer-box", () => ({ SteerBox: () => null }))
vi.mock("@/components/task-header", () => ({ TaskHeader: () => null }))
vi.mock("@/components/terminal-pane", () => ({ TerminalSection: () => null }))

import App from "./App"

describe("connection-bound update recovery", () => {
  it("keeps browser mode single-daemon without a misleading Local tab", () => {
    render(
      <DaemonRuntimeProvider transport={fakeDaemonTransport("local")}>
        <App />
      </DaemonRuntimeProvider>,
    )

    expect(screen.getByRole("img", { name: "Wisp" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Local" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Zoom/ })).toBeNull()
    expect(screen.queryByText("Wisp")).toBeNull()
  })

  it("polls and recovers the initiating runtime after the active provider switches", async () => {
    let finishInstall!: (status: UpdateStatus) => void
    let finishWait!: () => void
    mocks.install.mockReturnValueOnce(new Promise<UpdateStatus>((resolve) => (finishInstall = resolve)))
    mocks.waitForUpdatedDaemon.mockReturnValueOnce(new Promise<void>((resolve) => (finishWait = resolve)))

    const first = fakeDaemonTransport("connection-one")
    const second = fakeDaemonTransport("connection-two")
    const recoverFirst = vi.fn()
    const recoverSecond = vi.fn()
    const view = render(
      <DaemonRuntimeProvider transport={first} recoverAfterUpdate={recoverFirst}>
        <App />
      </DaemonRuntimeProvider>,
    )

    fireEvent.click(
      screen.getByRole("button", {
        name: `Update daemon ${UPDATE.latestVersion}`,
      })
    )
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith(UPDATE.latestVersion))

    view.rerender(
      <DaemonRuntimeProvider transport={second} recoverAfterUpdate={recoverSecond}>
        <App />
      </DaemonRuntimeProvider>,
    )
    expect(screen.queryByText("Updating daemon…")).toBeNull()
    finishInstall({ ...UPDATE, state: "restarting" })

    await waitFor(() =>
      expect(mocks.waitForUpdatedDaemon).toHaveBeenCalledWith(UPDATE.latestVersion, { transport: first }),
    )
    finishWait()

    await waitFor(() => expect(recoverFirst).toHaveBeenCalledOnce())
    expect(recoverSecond).not.toHaveBeenCalled()
  })

  it("keeps a Local daemon update visible and locked across Desktop tab changes", async () => {
    let finishInstall!: (status: UpdateStatus) => void
    let finishWait!: () => void
    mocks.install.mockReturnValueOnce(
      new Promise<UpdateStatus>((resolve) => (finishInstall = resolve))
    )
    mocks.waitForUpdatedDaemon.mockReturnValueOnce(
      new Promise<void>((resolve) => (finishWait = resolve))
    )
    const nativeBridge = desktopBridge()

    render(
      <DesktopUpdaterProvider bridge={nativeBridge} launchCheckDelay={60_000}>
        <DesktopApplicationProvider
          initial={desktopBootstrap()}
          bridge={nativeBridge}
        >
          <DesktopUpdateHarness />
        </DesktopApplicationProvider>
      </DesktopUpdaterProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /Updates/ }))
    fireEvent.click(
      screen.getByRole("button", { name: "Update Local daemon" })
    )
    await waitFor(() =>
      expect(mocks.install).toHaveBeenCalledWith(UPDATE.latestVersion)
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Select saved remote" })
    )
    await waitFor(() =>
      expect(screen.getByLabelText("active connection")).toHaveTextContent(
        REMOTE.id
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }))
    expect(screen.getByText("Updating Local daemon…")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Update Local daemon" })
    ).toBeNull()

    finishInstall({ ...UPDATE, state: "restarting" })
    await waitFor(() => expect(mocks.waitForUpdatedDaemon).toHaveBeenCalled())
    const initiatingTransport = mocks.waitForUpdatedDaemon.mock.calls.at(-1)?.[1]
      .transport
    expect(initiatingTransport.connectionId).toBe("local")
    finishWait()
    await waitFor(() =>
      expect(screen.queryByText("Restarting Local daemon…")).toBeNull()
    )
  })

  it("keeps a manual Local check visible and locked across Desktop tab changes", async () => {
    let finishRefresh!: (status: UpdateStatus) => void
    mocks.refresh.mockReturnValueOnce(
      new Promise<UpdateStatus>((resolve) => (finishRefresh = resolve))
    )
    const nativeBridge = desktopBridge()

    render(
      <DesktopUpdaterProvider bridge={nativeBridge} launchCheckDelay={60_000}>
        <DesktopApplicationProvider
          initial={desktopBootstrap()}
          bridge={nativeBridge}
        >
          <DesktopUpdateHarness />
        </DesktopApplicationProvider>
      </DesktopUpdaterProvider>
    )

    fireEvent.click(screen.getByRole("button", { name: /Updates/ }))
    fireEvent.click(screen.getByRole("button", { name: "Check now" }))
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())

    fireEvent.click(
      screen.getByRole("button", { name: "Select saved remote" })
    )
    await waitFor(() =>
      expect(screen.getByLabelText("active connection")).toHaveTextContent(
        REMOTE.id
      )
    )
    fireEvent.click(screen.getByRole("button", { name: /Updates/ }))
    expect(
      screen.getByRole("button", { name: "Checking Local daemon…" })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled()

    finishRefresh(UPDATE)
    await waitFor(() =>
      expect(screen.queryByText("Checking Local daemon…")).toBeNull()
    )
  })
})

describe("the top bar's left end", () => {
  it("drops the mark on Desktop, where the traffic lights and connection tabs own the corner", () => {
    const nativeBridge = desktopBridge()
    render(
      <DesktopUpdaterProvider bridge={nativeBridge} launchCheckDelay={60_000}>
        <DesktopZoomProvider>
          <DesktopApplicationProvider
            initial={desktopBootstrap()}
            bridge={nativeBridge}
          >
            <DaemonRuntimeProvider transport={fakeDaemonTransport("local")}>
              <App />
            </DaemonRuntimeProvider>
          </DesktopApplicationProvider>
        </DesktopZoomProvider>
      </DesktopUpdaterProvider>,
    )

    expect(screen.queryByRole("img", { name: "Wisp" })).toBeNull()
    expect(screen.getByRole("tab", { name: "Local" })).toBeInTheDocument()
  })
})

describe("the top bar's right end", () => {
  it("groups the app's own controls in one cluster after the spacer", () => {
    render(
      <DaemonRuntimeProvider transport={fakeDaemonTransport("local")}>
        <App />
      </DaemonRuntimeProvider>,
    )

    // updates, zoom and the gear are one group at 4px, not three controls
    // spread across the header's 10px — and the gear is still the corner
    const cluster = screen.getByRole("button", { name: "Settings" }).parentElement!
    expect(cluster.className.split(/\s+/)).toContain("gap-1")
    expect(cluster.parentElement!.tagName).toBe("HEADER")
    expect(cluster.parentElement!.lastElementChild).toBe(cluster)
    expect(cluster.lastElementChild).toBe(screen.getByRole("button", { name: "Settings" }))
  })
})

describe("the top bar's settings gear", () => {
  it("opens Wisp settings, with the appearance section inside", async () => {
    render(
      <DaemonRuntimeProvider transport={fakeDaemonTransport("local")}>
        <App />
      </DaemonRuntimeProvider>,
    )

    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Theme" })).toBeInTheDocument()
  })
})
