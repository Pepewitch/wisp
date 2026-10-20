import { useState } from "react"

import type { VerificationStatus } from "../../../shared/api/auto-review"
import { ProjectSettingsSpecimen } from "@/components/project-settings-dialog"
import type { VerificationFieldsModel } from "@/components/project-verification"
import { Eyebrow } from "@/components/primitives"
import { REPOS } from "@/lib/fixtures"
import type { HarnessInfo, ProjectVerifyAgent, ProjectVerifySecond } from "@/lib/types"

/*
 * The project settings' Verification section, drawn by the real form from
 * fixed models (a made-up recipe, areas and recipe task). Lives outside
 * `gallery.tsx`, which is the route, not a warehouse.
 */

const NOW = Date.now()
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const HARNESSES: HarnessInfo[] = [
  { name: "claude", hasModel: true, hasEffort: true, hasImage: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaults: { model: "opus-5" }, models: { list: ["opus-5", "sonnet-5"], defaultModel: "opus-5", probedAt: ago(60) } },
  { name: "codex", hasModel: true, hasEffort: true, hasImage: true, effortLevels: ["low", "medium", "high", "xhigh"], defaults: { model: "gpt-5.6-luna" }, models: { list: ["gpt-5.6-luna"], defaultModel: "gpt-5.6-luna", probedAt: ago(60) } },
]

const NONE: VerificationStatus = {
  state: "none", version: null, activatedAt: null, areas: [], draft: null, task: null, reviewer: null, attention: null,
}

const ACTIVE: VerificationStatus = {
  state: "active",
  version: "3",
  activatedAt: ago(60 * 26),
  areas: [
    { name: "editor", paths: ["web/src/editor/**", "web/src/store/**"], status: "proven", attention: "The launch step needs a seeded document; the recipe never creates one." },
    { name: "sidebar", paths: ["web/src/components/sidebar.tsx"], status: "proven", attention: null },
    { name: "api", paths: ["server/**"], status: "unproven", attention: null },
  ],
  draft: {
    taskId: "tvr3ip",
    savedAt: ago(8),
    areas: [
      { name: "editor", paths: ["web/src/editor/**"], status: "proven" },
      { name: "sidebar", paths: ["web/src/components/sidebar.tsx"], status: "proven" },
      { name: "api", paths: ["server/**"], status: "unproven" },
    ],
  },
  task: { id: "tvr3ip", mode: "fix", area: "editor", state: "running", archived: false },
  reviewer: { harness: "claude", model: "opus-5", effort: null },
  second: { harness: "codex", model: "gpt-5.6-luna", effort: null },
  attention: null,
}

function Specimen({ status, initial, initialSecond, busy = false, message = null }: {
  status: VerificationStatus
  initial: ProjectVerifyAgent | null
  /** the second reviewer, on a daemon with the review panel; undefined draws an older daemon's section */
  initialSecond?: ProjectVerifySecond
  busy?: boolean
  message?: VerificationFieldsModel["message"]
}) {
  const [agent, setAgent] = useState(initial)
  const [second, setSecond] = useState<ProjectVerifySecond>(initialSecond ?? null)
  const [recipeAgent, setRecipeAgent] = useState<ProjectVerifyAgent>({ harness: "claude", model: "opus-5" })
  const [note, setNote] = useState("")
  const model: VerificationFieldsModel = {
    status, now: NOW, readError: null, harnesses: HARNESSES, hidden: {}, agent, onAgentChange: setAgent,
    recipeAgent, onRecipeAgentChange: setRecipeAgent, note, onNoteChange: setNote,
    starting: null, activating: false, busy, message, onStart: () => {}, onActivate: () => {}, onOpenTask: () => {},
    ...(initialSecond !== undefined ? { second, onSecondChange: setSecond } : {}),
  }
  return <ProjectSettingsSpecimen project={{ ...REPOS[0]!, verify: initial }} verification={model} />
}

export function VerificationSpecimen() {
  return (
    <div className="flex flex-col gap-10">
      <div data-frame="verification-none">
        <Eyebrow>Verification — not set up, no reviewer agent chosen</Eyebrow>
        <Specimen status={NONE} initial={null} />
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          The recipe auto-review checks against lives in Wisp, never in the repo. Set up verification starts a recipe
          task, a normal visible task. Each task&apos;s own agent has no task to borrow from here, so while the reviewer
          is left on it a Recipe agent row picks the recipe task&apos;s harness, model and effort on the spot, starting
          from what a new task would use. That pick is never saved; the reviewer agent is saved with Save.
        </p>
      </div>
      <div data-frame="verification-active">
        <Eyebrow>Verification — active, an area needs attention, a draft waiting, a recipe task working</Eyebrow>
        <Specimen
          status={ACTIVE}
          initial={{ harness: "claude", model: "opus-5", effort: "high" }}
          initialSecond={{ harness: "codex", model: "gpt-5.6-luna" }}
          busy
          message={{ tone: "error", text: "Task tvr3ip is already working on this project's verification recipe" }}
        />
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Dots carry the hue, words stay gray: green for a proven area, faint for one not proven yet, red where a
          reviewer reported the recipe failing (with Fix beside it). Activate draft is an outline button — Save stays
          the dialog&apos;s one primary. A refusal from the daemon shows inline, in red. On a daemon with the review
          panel the Second reviewer sits under the Reviewer agent: a different agent here is a real second opinion.
          Each named reviewer has an effort beside its model: the harness&apos;s levels, or its default.
        </p>
      </div>
      <div data-frame="verification-second-off">
        <Eyebrow>Verification — the second reviewer off: every round has one reviewer</Eyebrow>
        <Specimen status={{ ...NONE, reviewer: { harness: "claude", model: "opus-5", effort: null }, second: "off" }} initial={{ harness: "claude", model: "opus-5" }} initialSecond="off" />
        <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          The Second reviewer offers Same agent as the reviewer (the default), Off — one reviewer, and the composer&apos;s
          model list. It is saved with Save as its own key, sent only when it changed and never to a daemon without
          the panel.
        </p>
      </div>
    </div>
  )
}
