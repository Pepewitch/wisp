import { LOCAL_CONNECTION_ID } from "./transport"

const CONNECTION_STORAGE_PREFIX = "wisp_connection"

export type ReadableStorage = Pick<Storage, "getItem">
export type WritableStorage = Pick<Storage, "setItem" | "removeItem">
export type ReadWriteStorage = ReadableStorage & WritableStorage

/** Keep daemon-owned browser preferences isolated by immutable connection ID. */
export function connectionStorageKey(
  connectionId: string,
  name: string
): string {
  return `${CONNECTION_STORAGE_PREFIX}:${encodeURIComponent(connectionId)}:${name}`
}

/**
 * Read one connection-owned value.
 *
 * The built-in local connection lazily adopts the pre-connection-runtime key.
 * Remote connections never inspect that key, so adding one cannot inherit a
 * preference from the daemon that happened to serve the browser before it.
 */
export function readConnectionStorage(
  connectionId: string,
  name: string,
  legacyKey: string,
  storage?: ReadWriteStorage
): string | null {
  try {
    const target = storage ?? localStorage
    const key = connectionStorageKey(connectionId, name)
    const scoped = target.getItem(key)
    if (scoped !== null) return scoped
    if (connectionId !== LOCAL_CONNECTION_ID) return null

    const legacy = target.getItem(legacyKey)
    if (legacy === null) return null

    // Only remove the fallback after the scoped write succeeds. If storage is
    // blocked or full, this read still works and a later read can retry.
    try {
      target.setItem(key, legacy)
      target.removeItem(legacyKey)
    } catch {
      // Migration is best-effort; the legacy value remains a valid local read.
    }
    return legacy
  } catch {
    return null
  }
}

/** Write one scoped value and retire the local legacy fallback after success. */
export function writeConnectionStorage(
  connectionId: string,
  name: string,
  legacyKey: string,
  value: string,
  storage?: WritableStorage
): void {
  try {
    const target = storage ?? localStorage
    target.setItem(connectionStorageKey(connectionId, name), value)
    if (connectionId === LOCAL_CONNECTION_ID) target.removeItem(legacyKey)
  } catch {
    // blocked or full storage costs only this convenience
  }
}

/** Clear a scoped value without allowing the local legacy value to reappear. */
export function removeConnectionStorage(
  connectionId: string,
  name: string,
  legacyKey: string,
  storage?: WritableStorage
): void {
  let target: WritableStorage
  try {
    target = storage ?? localStorage
  } catch {
    return
  }
  try {
    target.removeItem(connectionStorageKey(connectionId, name))
  } catch {
    // Keep trying the independent legacy cleanup below.
  }
  if (connectionId !== LOCAL_CONNECTION_ID) return
  try {
    target.removeItem(legacyKey)
  } catch {
    // blocked storage costs only this convenience
  }
}
