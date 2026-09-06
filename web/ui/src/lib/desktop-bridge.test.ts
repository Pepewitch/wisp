import { describe, expect, it } from "vitest"

import {
  createDesktopBridge,
  normalizeDesktopBootstrap,
  normalizeRemoteUrl,
  type DesktopBootstrap,
  type NativeInvoke,
} from "./desktop-bridge"

const BOOTSTRAP: DesktopBootstrap = {
  connections: [
    {
      id: "remote-one",
      kind: "remote",
      name: "Remote one",
      url: "https://wisp.example.test/",
      instanceId: "wisp-instance-remote-one",
      ready: true,
    },
    {
      id: "local",
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

describe("desktop native bridge", () => {
  it("uses the exact command names and direct camelCase arguments", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
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
      return BOOTSTRAP.connections[0] as T
    }
    const bridge = createDesktopBridge(nativeInvoke)

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
    ])
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
