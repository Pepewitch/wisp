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
    },
    { id: "local", kind: "local", name: "Local", url: null },
  ],
  activeConnectionId: "remote-one",
  proxyBaseUrl: "http://127.0.0.1:45123/connections/",
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
      return undefined as T
    }
    const bridge = createDesktopBridge(nativeInvoke)

    await bridge.bootstrap()
    await bridge.addRemoteConnection({
      name: "Remote two",
      url: "https://two.example.test",
      token: "test-token",
    })
    await bridge.renameConnection("remote-one", "Renamed")
    await bridge.reconnectConnection({
      connectionId: "remote-one",
      url: "https://new.example.test",
    })
    await bridge.removeConnection("remote-one")
    await bridge.pickLocalProject()
    await bridge.setupLocalWisp()

    expect(calls).toEqual([
      { command: "desktop_bootstrap", args: undefined },
      {
        command: "add_remote_connection",
        args: {
          name: "Remote two",
          url: "https://two.example.test",
          token: "test-token",
        },
      },
      {
        command: "rename_connection",
        args: { connectionId: "remote-one", name: "Renamed" },
      },
      {
        command: "reconnect_connection",
        args: { connectionId: "remote-one", url: "https://new.example.test" },
      },
      { command: "remove_connection", args: { connectionId: "remote-one" } },
      { command: "pick_local_project", args: undefined },
      { command: "setup_local_wisp", args: undefined },
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
          { id: "other", kind: "remote", name: "LOCAL", url: "https://x.test" },
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
