import { useEffect, useState, useSyncExternalStore, type ComponentProps } from "react"

import { SHELL_CONNECTING, ShellFrame, ShellStatus, ShellStatusAction } from "@/components/shell-frame"
import type { ShellView as ShellViewComponent } from "@/components/shell-view"
import { lazyModule } from "@/lib/lazy-module"

/**
 * xterm and its addons are about a sixth of the browser bundle, and only a
 * task's terminal needs them. The browser loads them with the first tab;
 * after that every tab, on every task, mounts synchronously.
 */
const shellView = lazyModule(() => import("@/components/shell-view"))

/**
 * One shell tab, drawn as a tab that is still connecting until its code has
 * arrived, which is what a new tab shows anyway. Not `React.lazy`: Suspense
 * holds a revealed boundary back for a moment, which would delay the socket.
 */
export function LazyShellView(props: ComponentProps<typeof ShellViewComponent>) {
  const loaded = useSyncExternalStore(shellView.subscribe, shellView.current)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (loaded) return
    let cancelled = false
    shellView.load().catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [loaded, attempt])

  if (loaded) return <loaded.ShellView {...props} />
  return (
    <ShellFrame active={props.active}>
      {failed ? (
        // A page open across a daemon upgrade asks for a chunk the new binary
        // no longer has, and only a reload brings the new names. That stays
        // the person's call, so a draft is never discarded for them.
        <ShellStatus
          wrap
          actions={
            <>
              <ShellStatusAction
                onClick={() => {
                  setFailed(false)
                  setAttempt((value) => value + 1)
                }}
              >
                retry
              </ShellStatusAction>
              <ShellStatusAction onClick={() => window.location.reload()}>reload</ShellStatusAction>
            </>
          }
        >
          The terminal code could not be loaded.
        </ShellStatus>
      ) : (
        <ShellStatus>{SHELL_CONNECTING}</ShellStatus>
      )}
    </ShellFrame>
  )
}
