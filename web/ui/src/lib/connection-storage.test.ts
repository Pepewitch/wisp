import { describe, expect, it } from "vitest"

import {
  connectionStorageKey,
  readConnectionStorage,
  type ReadWriteStorage,
  writeConnectionStorage,
} from "./connection-storage"

const LOCAL_CONNECTION = "local"
const REMOTE_CONNECTION = "remote-test"
const LEGACY_SHOW_ARCHIVED_KEY = "wisp_show_archived"
const SHOW_ARCHIVED_SETTING = "show_archived"

function memoryStorage(seed: Record<string, string> = {}): ReadWriteStorage {
  const values = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => values.get(key) ?? null,
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
})
