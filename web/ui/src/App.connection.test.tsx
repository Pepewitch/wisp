import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { DaemonRuntimeProvider } from "@/lib/runtime"
import type { UpdateStatus } from "@/lib/types"
import { fakeDaemonTransport } from "@/test/runtime"

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
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
  latestVersion: "0.4.0-alpha.7",
  canAutoUpdate: true,
  state: "available",
  installMethod: "homebrew",
  message: null,
  checkedAt: "2026-09-05T08:00:00Z",
}

vi.mock("@/hooks/queries", () => ({
  useTasks: () => ({ data: fixtures.tasks, error: null, isPending: false }),
  useStatus: () => ({ data: fixtures.status, error: null }),
  useRepos: () => ({ data: fixtures.repos }),
  useTaskDetail: () => ({ data: undefined }),
  usePullRequestStatus: () => ({ data: undefined }),
  usePullRequestOverview: () => ({ data: fixtures.pullRequests }),
  useHarnesses: () => ({ data: fixtures.harnesses, error: null }),
  useUpdateStatus: () => ({ data: UPDATE }),
  useTaskSkills: () => ({ data: undefined }),
}))

vi.mock("@/hooks/mutations", () => ({
  useInstallUpdate: () => ({ mutateAsync: mocks.install, isPending: false }),
}))

vi.mock("@/hooks/useLogStream", () => ({
  useLogStream: () => ({ activity: [], note: null }),
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

    fireEvent.click(screen.getByRole("button", { name: `Update ${UPDATE.latestVersion}` }))
    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith(UPDATE.latestVersion))

    view.rerender(
      <DaemonRuntimeProvider transport={second} recoverAfterUpdate={recoverSecond}>
        <App />
      </DaemonRuntimeProvider>,
    )
    finishInstall({ ...UPDATE, state: "restarting" })

    await waitFor(() =>
      expect(mocks.waitForUpdatedDaemon).toHaveBeenCalledWith(UPDATE.latestVersion, { transport: first }),
    )
    finishWait()

    await waitFor(() => expect(recoverFirst).toHaveBeenCalledOnce())
    expect(recoverSecond).not.toHaveBeenCalled()
  })
})
