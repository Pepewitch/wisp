import { useTick } from "@/hooks/useTick"
import { backgroundDetail, backgroundLabel } from "@/lib/state"
import type { ApiTask } from "@/lib/types"

/**
 * What a task's background work is, one line each, for a hover. Subscribes
 * to the clock only while there IS background work, so the thirty idle dots
 * in a sidebar start no timer and still read a valid cached instant.
 */
export function useBackgroundDetail(background: ApiTask["background"]): string | null {
  return backgroundDetail(background, useTick(Boolean(backgroundLabel(background))))
}
