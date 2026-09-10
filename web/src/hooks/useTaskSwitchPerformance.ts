import { useEffect, useLayoutEffect } from "react"

import {
  markConversationDetailLoaded,
  markTaskSelected,
} from "@/lib/task-switch-performance"

/** Bind content-free performance marks to one selected-task lifecycle. */
export function useTaskSwitchPerformance(
  selectedId: string | null,
  detailId: string | undefined,
  dataUpdatedAt: number,
): void {
  useLayoutEffect(() => {
    if (selectedId) markTaskSelected()
  }, [selectedId])

  useEffect(() => {
    if (selectedId && detailId === selectedId) markConversationDetailLoaded()
  }, [selectedId, detailId, dataUpdatedAt])
}
