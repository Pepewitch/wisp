import { describe, expect, it } from "vitest"

import {
  clearConnectionStorage,
  connectionStorageKey,
  readConnectionStorage,
  writeConnectionStorage,
} from "./connection-storage"

const LOCAL_CONNECTION = "local"
const REMOTE_CONNECTION = "remote-test"
const LEGACY_SHOW_ARCHIVED_KEY = "wisp_show_archived"
const SHOW_ARCHIVED_SETTING = "show_archived"

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed))
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe("show-archived connection storage", () => {
  it("lazily migrates the legacy toggle into the reserved local connection", () => {
    const storage = memoryStorage({ [LEGACY_SHOW_ARCHIVED_KEY]: "1" })

    expect(
      readConnectionStorage(
        LOCAL_CONNECTION,
        SHOW_ARCHIVED_SETTING,
        LEGACY_SHOW_ARCHIVED_KEY,
        storage
      )
    ).toBe("1")
    expect(storage.getItem(LEGACY_SHOW_ARCHIVED_KEY)).toBeNull()
    expect(
      storage.getItem(
        connectionStorageKey(LOCAL_CONNECTION, SHOW_ARCHIVED_SETTING)
      )
    ).toBe("1")
  })

  it("keeps remote toggle values isolated from local and legacy state", () => {
    const storage = memoryStorage({ [LEGACY_SHOW_ARCHIVED_KEY]: "1" })

    expect(
      readConnectionStorage(
        REMOTE_CONNECTION,
        SHOW_ARCHIVED_SETTING,
        LEGACY_SHOW_ARCHIVED_KEY,
        storage
      )
    ).toBeNull()
    expect(storage.getItem(LEGACY_SHOW_ARCHIVED_KEY)).toBe("1")

    writeConnectionStorage(
      REMOTE_CONNECTION,
      SHOW_ARCHIVED_SETTING,
      LEGACY_SHOW_ARCHIVED_KEY,
      "0",
      storage
    )

    expect(
      readConnectionStorage(
        REMOTE_CONNECTION,
        SHOW_ARCHIVED_SETTING,
        LEGACY_SHOW_ARCHIVED_KEY,
        storage
      )
    ).toBe("0")
    expect(
      readConnectionStorage(
        LOCAL_CONNECTION,
        SHOW_ARCHIVED_SETTING,
        LEGACY_SHOW_ARCHIVED_KEY,
        storage
      )
    ).toBe("1")
  })

  it("clears every removed remote value without touching another connection", () => {
    const remoteArchived = connectionStorageKey(
      REMOTE_CONNECTION,
      SHOW_ARCHIVED_SETTING
    )
    const remoteTask = connectionStorageKey(REMOTE_CONNECTION, "selected_task")
    const localTask = connectionStorageKey(LOCAL_CONNECTION, "selected_task")
    const storage = memoryStorage({
      [remoteArchived]: "1",
      [remoteTask]: "synthetic-task",
      [localTask]: "local-task",
      unrelated: "keep",
    })

    clearConnectionStorage(REMOTE_CONNECTION, storage)

    expect(storage.getItem(remoteArchived)).toBeNull()
    expect(storage.getItem(remoteTask)).toBeNull()
    expect(storage.getItem(localTask)).toBe("local-task")
    expect(storage.getItem("unrelated")).toBe("keep")
  })
})
