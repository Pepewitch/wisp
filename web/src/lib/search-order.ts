import type { ProjectGroup } from "@/lib/projects"
import type { SearchTaskHit } from "@/lib/types"

/** The flat, keyboard-walkable order the groups are rendered in. */
export function searchOrder(groups: ProjectGroup[], hits: SearchTaskHit[]): string[] {
  const order: string[] = []
  for (const group of groups) {
    for (const task of group.tasks) {
      if (hits.some((hit) => hit.id === task.id)) order.push(task.id)
    }
  }
  return order
}
