import { SteerBox } from "@/components/steer-box"
import { useHarnessFeatures } from "@/hooks/queries"
import type { ApiTask, HarnessInfo, StatusEntry, TaskSkills, Turn } from "@/lib/types"

/** The selected task's steer box, with what its harness can take. */
export function TaskComposer({
  task,
  harnesses,
  skills,
  status,
  turns,
  touch,
}: {
  task: ApiTask | null
  harnesses: HarnessInfo[] | undefined
  skills: TaskSkills | undefined
  status: StatusEntry | undefined
  turns: Turn[] | undefined
  touch: boolean
}) {
  const features = useHarnessFeatures()
  const harness = task
    ? harnesses?.find((candidate) => candidate.name === task.harness)
    : undefined
  return (
    <SteerBox
      task={task}
      harnesses={harnesses}
      canSwitchAgent={features.data?.taskAgentSwitching === true}
      canChooseDelivery={features.data?.steerDelivery === true}
      hasImage={harness?.hasImage}
      imageNote={harness?.imageNote}
      probeCommands={harness?.probeCommands}
      skills={skills}
      compact={harness?.compact}
      status={status}
      turns={turns}
      runningSince={
        turns?.find((turn) => turn.status === "running")?.started_at ?? null
      }
      touch={touch}
    />
  )
}
