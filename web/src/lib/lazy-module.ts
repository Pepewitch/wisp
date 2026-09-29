/**
 * A module the daemon-served browser bundle loads on first use rather than
 * with the entry, then holds, so every later mount renders it synchronously.
 *
 * Only the browser build (`vite build --mode web`) splits it into its own
 * chunk. Every other build has it locally — Desktop's single file inlines the
 * dynamic import, and dev and tests resolve it from disk — so those ask for it
 * the moment this module is evaluated, and their first render finds it loaded,
 * exactly as it did when the import was static.
 */
export interface LazyModule<T> {
  /** the loaded value, or null until it has arrived */
  current(): T | null
  /** Starts the load, or joins the one in flight. A failure can be asked for again. */
  load(): Promise<T>
  subscribe(listener: () => void): () => void
}

const SPLIT_BUILD = import.meta.env.MODE === "web"

export function lazyModule<T>(importer: () => Promise<T>): LazyModule<T> {
  let value: T | null = null
  let pending: Promise<T> | null = null
  const listeners = new Set<() => void>()
  const module: LazyModule<T> = {
    current: () => value,
    load() {
      pending ??= importer().then(
        (loaded) => {
          value = loaded
          for (const listener of listeners) listener()
          return loaded
        },
        (error: unknown) => {
          // a page kept open across a daemon upgrade asks for a chunk the new
          // binary no longer has; a later attempt (or a reload) must be possible
          pending = null
          throw error
        }
      )
      return pending
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  if (!SPLIT_BUILD) void module.load().catch(() => undefined)
  return module
}
