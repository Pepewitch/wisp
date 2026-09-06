import { describe, expect, it, vi } from "vitest"

import {
  FOCUS_TASK_EVENT,
  createDesktopBridge,
  normalizeDesktopBootstrap,
  normalizeRemoteUrl,
  type DesktopBootstrap,
  type DesktopUpdateStatus,
  type NativeListen,
  type NativeInvoke,
  type TaskFocusRequest,
} from "./desktop-bridge"

const BOOTSTRAP: DesktopBootstrap = {
  connections: [
    {
      id: "remote-one",
      routeRevision: 0,
      kind: "remote",
      name: "Remote one",
      url: "https://wisp.example.test/",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    },
    {
      id: "local",
      routeRevision: 0,
      kind: "local",
      name: "Local",
      url: null,
      instanceId: "wisp-instance-local",
      ready: true,
    },
  ],
  activeConnectionId: "remote-one",
  proxyBaseUrl: "http://127.0.0.1:45123/per-launch-capability/",
  local: {
    available: true,
    configPath: "/synthetic/.wisp/config.json",
    baseUrl: "http://127.0.0.1:18710",
    instanceId: "wisp-instance-local",
    hasToken: true,
    reason: null,
  },
}

const DESKTOP_UPDATE: DesktopUpdateStatus = {
  channel: "alpha",
  configured: true,
  currentVersion: "0.4.0-alpha.8",
  latestVersion: "0.4.0-alpha.9",
  phase: "available",
  releaseNotes: "Synthetic release notes.",
  publishedAt: "2026-09-06T12:00:00Z",
  checkedAt: "2026-09-06T12:01:00Z",
  downloadedBytes: 0,
  totalBytes: 42,
  message: null,
}

describe("desktop native bridge", () => {
  it("uses the exact command names and direct camelCase arguments", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const events: string[] = []
    const nativeInvoke: NativeInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>
    ) => {
      calls.push({ command, args })
      if (command === "desktop_bootstrap") return BOOTSTRAP as T
      if (command === "pick_local_project") return "/synthetic/project" as T
      if (
        command === "probe_remote_connection" ||
        command === "probe_saved_connection"
      )
        return {
          instanceId: "wisp-instance-remote-two",
          apiProtocolVersion: 1,
          version: "0.4.0-synthetic",
        } as T
      if (
        command === "setup_local_wisp" ||
        command === "apply_local_wisp_setup"
      )
        return {
          status: BOOTSTRAP.local,
          cliPath: "/synthetic/bin/wisp",
          daemonReachable: true,
          nextStep: "ready",
          message: "Local Wisp is ready.",
        } as T
      if (command === "remove_connection") return undefined as T
      if (
        command === "desktop_update_status" ||
        command === "check_desktop_update" ||
        command === "install_desktop_update"
      )
        return DESKTOP_UPDATE as T
      return BOOTSTRAP.connections[0] as T
    }
    const nativeListen: NativeListen = async (event, listener) => {
      events.push(event)
      listener({ payload: DESKTOP_UPDATE })
      return () => undefined
    }
    const bridge = createDesktopBridge(nativeInvoke, nativeListen)

    await bridge.bootstrap()
    await bridge.selectConnection("remote-one")
    await bridge.probeRemoteConnection({
      url: "https://two.example.test",
      token: "test-token",
    })
    await bridge.addRemoteConnection({
      name: "Remote two",
      url: "https://two.example.test",
      token: "test-token",
      expectedInstanceId: "wisp-instance-remote-two",
    })
    await bridge.renameConnection("remote-one", "Renamed")
    await bridge.reconnectConnection({
      connectionId: "remote-one",
      url: "https://new.example.test",
      expectedInstanceId: "wisp-instance-remote-two",
    })
    await bridge.probeSavedConnection({ connectionId: "remote-one" })
    await bridge.removeConnection("remote-one")
    await bridge.resetDesktopData()
    await bridge.pickLocalProject()
    await bridge.setupLocalWisp()
    await bridge.applyLocalWispSetup("start-daemon")
    await bridge.openExternalUrl("https://example.test/pull/1")
    await bridge.desktopUpdateStatus()
    await bridge.checkDesktopUpdate()
    await bridge.installDesktopUpdate("0.4.0-alpha.9")
    await bridge.relaunchDesktop()
    let eventStatus: DesktopUpdateStatus | null = null
    const unlisten = await bridge.onDesktopUpdateStatus((status) => {
      eventStatus = status
    })
    unlisten()
    await bridge.revealWorktreeFile({
      connectionId: "local",
      worktreePath: "/synthetic/worktree",
      path: ".context/PLAN.md",
    })

    expect(calls).toEqual([
      { command: "desktop_bootstrap", args: undefined },
      {
        command: "select_desktop_connection",
        args: { connectionId: "remote-one" },
      },
      {
        command: "probe_remote_connection",
        args: {
          url: "https://two.example.test",
          token: "test-token",
        },
      },
      {
        command: "add_remote_connection",
        args: {
          name: "Remote two",
          url: "https://two.example.test",
          token: "test-token",
          expectedInstanceId: "wisp-instance-remote-two",
        },
      },
      {
        command: "rename_connection",
        args: { connectionId: "remote-one", name: "Renamed" },
      },
      {
        command: "reconnect_connection",
        args: {
          connectionId: "remote-one",
          url: "https://new.example.test",
          expectedInstanceId: "wisp-instance-remote-two",
        },
      },
      {
        command: "probe_saved_connection",
        args: { connectionId: "remote-one" },
      },
      { command: "remove_connection", args: { connectionId: "remote-one" } },
      { command: "reset_desktop_data", args: undefined },
      {
        command: "pick_local_project",
        args: { connectionId: "local" },
      },
      { command: "setup_local_wisp", args: undefined },
      {
        command: "apply_local_wisp_setup",
        args: { expectedStep: "start-daemon" },
      },
      {
        command: "open_external_url",
        args: { url: "https://example.test/pull/1" },
      },
      { command: "desktop_update_status", args: undefined },
      { command: "check_desktop_update", args: undefined },
      {
        command: "install_desktop_update",
        args: { confirmedVersion: "0.4.0-alpha.9" },
      },
      { command: "relaunch_desktop", args: undefined },
      {
        command: "reveal_worktree_file",
        args: {
          connectionId: "local",
          worktreePath: "/synthetic/worktree",
          path: ".context/PLAN.md",
        },
      },
    ])
    expect(events).toEqual(["desktop-update-status"])
    expect(eventStatus).toEqual(DESKTOP_UPDATE)
  })

  it("orders Local first, freezes routing metadata, and strips unknown native fields", () => {
    const bootstrap = normalizeDesktopBootstrap({
      ...BOOTSTRAP,
      connections: [
        {
          ...BOOTSTRAP.connections[0]!,
          token: "must-not-cross",
        } as unknown as DesktopBootstrap["connections"][number],
        BOOTSTRAP.connections[1]!,
      ],
    })

    expect(bootstrap.connections.map((connection) => connection.id)).toEqual([
      "local",
      "remote-one",
    ])
    expect(bootstrap.connections[1]).not.toHaveProperty("token")
    expect(bootstrap.local).not.toHaveProperty("token")
    expect(Object.isFrozen(bootstrap)).toBe(true)
    expect(Object.isFrozen(bootstrap.connections)).toBe(true)
    expect(Object.isFrozen(bootstrap.connections[0])).toBe(true)
  })

  it("rejects malformed, duplicate, or non-loopback routing metadata", () => {
    expect(() =>
      normalizeDesktopBootstrap({ ...BOOTSTRAP, activeConnectionId: "missing" })
    ).toThrow("unknown connection")
    expect(() =>
      normalizeDesktopBootstrap({
        ...BOOTSTRAP,
        connections: [
          ...BOOTSTRAP.connections,
          {
            id: "other",
            routeRevision: 0,
            kind: "remote",
            name: "LOCAL",
            url: "https://x.test",
            instanceId: "wisp-instance-other",
            ready: true,
          },
        ],
      })
    ).toThrow("Duplicate desktop connection name")
    expect(() =>
      normalizeDesktopBootstrap({
        ...BOOTSTRAP,
        proxyBaseUrl: "http://192.0.2.1:45123/proxy",
      })
    ).toThrow("literal loopback")
    expect(() =>
      normalizeDesktopBootstrap({
        ...BOOTSTRAP,
        connections: [
          BOOTSTRAP.connections[1]!,
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `remote-${index}`,
            routeRevision: 0,
            kind: "remote" as const,
            name: `Remote ${index}`,
            url: `https://remote-${index}.example.test`,
            instanceId: `wisp-instance-${index}`,
            ready: true,
          })),
        ],
        activeConnectionId: "local",
      })
    ).toThrow("at most 8 connections")
  })

  it("rejects inconsistent native application update state", async () => {
    const nativeInvoke: NativeInvoke = async <T>() =>
      ({
        ...DESKTOP_UPDATE,
        configured: false,
      }) as T
    const bridge = createDesktopBridge(nativeInvoke)
    await expect(bridge.desktopUpdateStatus()).rejects.toThrow(
      "inconsistent application update status"
    )
  })
})

describe("remote daemon URL policy", () => {
  it.each([
    ["https://wisp.example.test/", "https://wisp.example.test"],
    ["http://127.0.0.1:8811/", "http://127.0.0.1:8811"],
    ["http://[::1]:8811/", "http://[::1]:8811"],
  ])("accepts %s", (input, normalized) => {
    expect(normalizeRemoteUrl(input)).toBe(normalized)
  })

  it.each([
    "http://localhost:8811",
    "http://127.0.0.2:8811",
    "http://10.0.0.2:8811",
    "ftp://wisp.example.test",
    "https://user:secret@wisp.example.test",
    "https://wisp.example.test?token=secret",
  ])("rejects %s", (input) => {
    expect(() => normalizeRemoteUrl(input)).toThrow()
  })
})

describe("desktop task notifications", () => {
  it("posts one validated notification per finished task", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
    const nativeInvoke: NativeInvoke = async <T>(
      command: string,
      args?: Record<string, unknown>
    ) => {
      calls.push({ command, args })
      return undefined as T
    }
    const bridge = createDesktopBridge(
      nativeInvoke,
      async () => () => undefined
    )

    await bridge.notifyTaskTransition({
      connectionId: "remote-one",
      taskId: "t2345",
      title: "Fix the flaky test",
      body: "Needs input · Remote one",
    })
    expect(calls).toEqual([
      {
        command: "notify_task_transition",
        args: {
          notification: {
            connectionId: "remote-one",
            taskId: "t2345",
            title: "Fix the flaky test",
            body: "Needs input · Remote one",
          },
        },
      },
    ])

    await expect(
      bridge.notifyTaskTransition({
        connectionId: "../local",
        taskId: "t2345",
        title: "x",
        body: "y",
      })
    ).rejects.toThrow(/valid connection and task ids/)
    await expect(
      bridge.notifyTaskTransition({
        connectionId: "local",
        taskId: "t 1",
        title: "x",
        body: "y",
      })
    ).rejects.toThrow(/valid connection and task ids/)
    expect(calls).toHaveLength(1)
  })

  it("relays only well-formed focus requests from the native click event", async () => {
    let deliver: ((event: { payload: unknown }) => void) | null = null
    const events: string[] = []
    const unlisten = vi.fn()
    const nativeListen: NativeListen = async (event, handler) => {
      events.push(event)
      deliver = handler
      return unlisten
    }
    const bridge = createDesktopBridge(
      async <T>() => undefined as T,
      nativeListen
    )
    const seen: TaskFocusRequest[] = []
    const stop = await bridge.onFocusTask((request) => seen.push(request))

    expect(events).toEqual([FOCUS_TASK_EVENT])
    deliver!({ payload: { connectionId: "local", taskId: "t2345" } })
    deliver!({ payload: { connectionId: "../local", taskId: "t2345" } })
    deliver!({ payload: { connectionId: "local", taskId: "t 1" } })
    deliver!({ payload: null })
    deliver!({ payload: "local:t2345" })
    expect(seen).toEqual([{ connectionId: "local", taskId: "t2345" }])

    stop()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
