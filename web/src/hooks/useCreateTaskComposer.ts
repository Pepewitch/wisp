import { useEffect, useState } from "react"

import { useAutopilotChoice } from "@/hooks/useAutopilotChoice"
import { useBriefChoice } from "@/hooks/useBriefChoice"
import { useChoiceTaskDefaults } from "@/hooks/useModelTaskDefaults"
import { useSuffixPrompts } from "@/hooks/queries"
import { usePendingAttachments } from "@/lib/attachments"
import {
  createTaskScope,
  readCreateTaskDraft,
  writeCreateTaskDraft,
  writePendingAttachmentCount,
} from "@/lib/drafts"
import { initialChoice, modelOptionsFor, type ModelChoice } from "@/lib/model-choice"
import type { HarnessInfo, TaskMode } from "@/lib/types"

/** One in-memory create composer per connection and project, including raw attachment Files. */
export function useCreateTaskComposer(
  connectionId: string,
  repoPath: string,
  harnesses: HarnessInfo[],
  preferredChoice: ModelChoice | null,
) {
  const [saved] = useState(() => readCreateTaskDraft(connectionId, repoPath))
  const [prompt, setPrompt] = useState(saved?.prompt ?? "")
  const [choice, setChoice] = useState<ModelChoice | null>(() => saved?.choice ?? initialChoice(harnesses, preferredChoice))
  const [effort, setEffort] = useState(
    () => saved?.effort ?? harnesses.find((h) => h.name === choice?.harness)?.defaults.reasoningEffort ?? "",
  )
  const [fast, setFast] = useState(saved?.fast ?? false)
  const [mode, setMode] = useState<TaskMode>(saved?.mode ?? "worktree")
  // A base override belongs to this task, not the project's resolved default.
  const [base, setBase] = useState(saved?.base ?? "")
  const taskDefaults = useChoiceTaskDefaults(choice)
  const autopilot = useAutopilotChoice(mode, saved?.autopilot, taskDefaults)
  const [suffixPromptId, setSuffixPromptId] = useState<string | null>(saved?.suffixPromptId ?? null)

  const harness = harnesses.find((h) => h.name === choice?.harness) ?? null
  const brief = useBriefChoice(harness, saved, taskDefaults.brief)
  const modelAvailable = !!harness && !!choice && modelOptionsFor(harness).includes(choice.model)
  const suffixPrompts = useSuffixPrompts(suffixPromptId !== null)
  // If discovery failed, let the daemon make the final decision at submit.
  const suffixAvailable = !suffixPromptId || !suffixPrompts.data ||
    suffixPrompts.data.some((prompt) => prompt.id === suffixPromptId)
  const canSubmit = repoPath !== "" && prompt.trim() !== "" && !!choice?.model &&
    modelAvailable && suffixAvailable && !suffixPrompts.isFetching &&
    (!suffixPromptId || !!suffixPrompts.data || suffixPrompts.isError)
  const attachments = usePendingAttachments({
    harness: harness?.name ?? null,
    hasImage: harness?.hasImage,
    imageNote: harness?.imageNote,
    rememberKey: `${connectionId}\u0000${createTaskScope(repoPath)}`,
  })

  useEffect(() => {
    writeCreateTaskDraft(connectionId, repoPath, {
      prompt, choice, effort, fast, brief: brief.chosen, mode, base, suffixPromptId, autopilot: autopilot.chosen,
    })
  }, [connectionId, repoPath, prompt, choice, effort, fast, brief.chosen, mode, base, suffixPromptId, autopilot.chosen])
  useEffect(() => {
    writePendingAttachmentCount(connectionId, createTaskScope(repoPath), attachments.list.length)
  }, [connectionId, repoPath, attachments.list.length])

  const reseedForHarness = (name: string) => {
    const destination = harnesses.find((candidate) => candidate.name === name)
    setEffort(destination?.defaults.reasoningEffort ?? "")
    if (!destination?.hasFastMode) setFast(false)
    // another model brings its own task defaults, the way it brings its effort
    brief.reset()
    autopilot.reset()
  }

  return {
    prompt, setPrompt, choice, setChoice, effort, setEffort, fast, setFast,
    mode, setMode, base, setBase, autopilot, brief, suffixPromptId, setSuffixPromptId,
    harness, attachments, modelAvailable, suffixAvailable, canSubmit, reseedForHarness,
  }
}
