import type { ReactNode } from "react"

import { ActivityList } from "@/components/activity-list"
import {
  PALETTE_GROUPS,
  PROBE_CONTEXT_ANSWER,
  PR_SPECIMEN,
  ROW_PR_SPECIMENS,
  SUBAGENT_SPECIMEN,
  SURFACES,
} from "@/components/gallery-fixtures"
import { ArrowUp, More, Refresh, WispMark } from "@/components/icons"
import { Button, DiffStat, Eyebrow, Meta, PaneHeader, POPOVER_SURFACE, Rule, StateDot, Tab } from "@/components/primitives"
import { Prose } from "@/components/prose"
import { ProbePanel } from "@/components/probe-panel"
import { ProjectSettingsSpecimen } from "@/components/project-settings-dialog"
import { PullRequestStatusLink } from "@/components/pull-request-status"
import { SlashPaletteList } from "@/components/slash-palette"
import { RowArchiveButton, TaskCard, TaskRow } from "@/components/task-row"
import { STATE_LABEL } from "@/lib/state"
import { REPOS, STATUS, TASKS } from "@/lib/fixtures"
import { TASK_STATES } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The living rulebook. The wisp-dev frontend reference is the law; this route is the law
 * rendered on real components. Add a primitive, add its entry here in the same
 * diff — an undocumented primitive is an incomplete change.
 */
/** A stand-in for a real thumbnail: the gallery has no daemon to fetch bytes from. */
function SpecimenThumb({ label }: { label: string }) {
  return (
    <div className="flex size-14 items-center justify-center rounded-sm bg-border-strong font-mono text-[10.5px] text-muted-foreground">
      {label}
    </div>
  )
}

export function Gallery() {
  return (
    <div className="scroll-slim h-dvh overflow-y-auto bg-background">
      <div className="mx-auto max-w-[1100px] px-10 pt-10 pb-24">
        <header className="flex items-start gap-4 border-b border-border pb-5">
          <WispMark className="mt-0.5 size-6 shrink-0" />
          <div className="flex-1">
            <h1 className="text-[22px] font-semibold tracking-[-0.018em]">Graphite &amp; violet</h1>
            <p className="mt-1.5 max-w-[640px] text-[13px] text-fg-secondary">
              A neutral near-black scale, four levels of gray text, and one violet that only ever means{" "}
              <em className="text-foreground not-italic">this is live</em> or{" "}
              <em className="text-foreground not-italic">this is the one action</em>.
            </p>
          </div>
          <a href="#/" className="text-[12px] text-muted-foreground hover:text-foreground">
            Back to the app
          </a>
        </header>

        <FoundationSpecimens />

        <Section title="The row that carries the app">
          <div className="grid grid-cols-2 gap-10">
            <div>
              <Eyebrow className="text-state-done">Keep — one 26px line</Eyebrow>
              <div className="mt-2.5 rounded-lg border border-border bg-sidebar p-1.5">
                {TASKS.slice(0, 4).map((t, i) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    status={STATUS[t.id]}
                    pullRequest={ROW_PR_SPECIMENS[i]}
                    selected={i === 0}
                    onSelect={() => {}}
                  />
                ))}
              </div>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                A 6px state dot, the truncating name, a glanceable PR icon, and the git marks /api/status serves.
                Gray means associated, red means blocked, and violet means merged; the icon is status, not an action.
                Selection is the background and nothing else; hover any row for the rest. The last row's
                worktree is one git has forgotten: that slot carries muted words rather than nothing, because an empty
                slot reads as clean. Hover a row and that same right edge becomes its archive control: PR and git
                marks fade out so no control overlaps the task title.
              </p>
            </div>
            <div>
              <Eyebrow>Hover card</Eyebrow>
              <div className={cn(POPOVER_SURFACE, "mt-2.5 w-[302px] rounded-xl p-3.5")}>
                <TaskCard
                  task={TASKS[1]!}
                  status={STATUS.tppxvp}
                  pullRequest={ROW_PR_SPECIMENS[1]}
                />
              </div>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Branch, PR freshness, agent, turns, changes, worktree. Everything the one-line row gave up, on
                demand, for one row at a time.
              </p>
            </div>
          </div>
        </Section>

        <InteractionSpecimens />
        <WorkflowSpecimens />
      </div>
    </div>
  )
}

function FoundationSpecimens() {
  return (
    <>
      <Section title="Surfaces">
          <div className="flex overflow-hidden rounded-lg border border-border-strong">
            {SURFACES.map((sf) => (
              <div key={sf.token} className="h-16 flex-1" style={{ background: sf.hex }} />
            ))}
          </div>
          <div className="mt-4 grid grid-flow-col grid-cols-2 grid-rows-4 gap-x-10 gap-y-2">
            {SURFACES.map((sf) => (
              <div key={sf.token} className="flex items-baseline gap-2.5">
                <span
                  className="size-2.5 shrink-0 translate-y-px rounded-[3px] border border-border-strong"
                  style={{ background: sf.hex }}
                />
                <span className="shrink-0 text-[12px]">{sf.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{sf.note}</span>
                <span className="shrink-0 font-mono text-[11px] text-fg-secondary">{sf.hex}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-faint">{sf.token}</span>
              </div>
            ))}
          </div>
      </Section>

      <Section title="Text — four levels, and four is enough">
          <div className="flex flex-col gap-3">
            <TextRow cls="text-foreground" name="foreground" note="Titles, prose, the thing you read" />
            <TextRow cls="text-fg-secondary" name="fg-secondary" note="Labels, tab text, tool verbs" />
            <TextRow cls="text-muted-foreground" name="muted-foreground" note="Branches, paths, counts, model" />
            <TextRow cls="text-faint" name="faint" note="Eyebrows, separators, timings, placeholders" />
          </div>
          <p className="mt-5 border-t border-border pt-4 text-[11.5px] leading-relaxed text-muted-foreground">
            Sentence case for anything Wisp wrote: <span className="text-fg-secondary">Changes</span>,{" "}
            <span className="text-fg-secondary">Show archived</span>,{" "}
            <span className="text-fg-secondary">Needs input</span>. Lowercase survives only where it is literal
            data — <span className="font-mono text-fg-secondary">droid</span>,{" "}
            <span className="font-mono text-fg-secondary">kimi-k3</span>,{" "}
            <span className="font-mono text-fg-secondary">needs-input</span> in a payload. Uppercase is reserved
            for the one eyebrow per pane.
          </p>
      </Section>

      <Section title="The one accent">
          <div className="flex gap-2.5">
            {[
              ["Accent", "bg-primary", "oklch(.705 .155 300)"],
              ["Soft", "bg-accent-soft", "oklch(.79 .125 300)"],
              ["Dim", "bg-accent-dim", "oklch(.46 .105 300)"],
              ["Wash", "bg-accent-wash", "15% α"],
            ].map(([label, cls, val]) => (
              <div key={label} className="flex-1">
                <div className={`h-14 rounded-lg border border-border ${cls}`} />
                <div className="mt-2 text-[12px]">{label}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{val}</div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11.5px] leading-relaxed text-muted-foreground">
            Five places, and nowhere else: the running dot, the one primary action, the send button, the focus
            ring, and inline code in prose. Selection and active tabs are a background change — they never take
            the hue. If a sixth appears, one of them was not load-bearing.
          </p>
      </Section>

      <Section title="Buttons — 22 / 26 / 32, and no other heights">
          <div className="flex flex-wrap items-center gap-2">
            <Button tone="primary">
              <ArrowUp />
              Push
            </Button>
            <Button>Archive</Button>
            <Button tone="outline" disabled>
              Push
            </Button>
            <Button icon aria-label="More">
              <More />
            </Button>
            <Button size="sm" icon aria-label="Refresh">
              <Refresh />
            </Button>
            <Button size="lg" tone="outline">
              Create task
            </Button>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <PullRequestStatusLink pullRequest={PR_SPECIMEN} />
            <span className="text-[11.5px] text-muted-foreground">
              Branch outcome replaces the task header's Push button; unsupported or absent status renders nothing.
            </span>
          </div>
      </Section>

      <Section title="Tabs — selection is a background pill">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-2">
            <Tab active>Shell 1</Tab>
            <Tab>Shell 2</Tab>
            <Tab count={6}>Changes</Tab>
          </div>
      </Section>

      <Section title="States — hue on the dot, and the words stay gray">
          <div className="grid grid-cols-2 gap-x-10 gap-y-2.5">
            {TASK_STATES.map((s) => (
              <div key={s} className="flex items-center gap-2.5">
                <StateDot state={s} />
                <span className="text-[12px] text-fg-secondary">{STATE_LABEL[s]}</span>
                <Rule />
                <span className="font-mono text-[10.5px] text-faint">{s}</span>
              </div>
            ))}
          </div>
          <p className="mt-5 border-t border-border pt-4 text-[11.5px] leading-relaxed text-muted-foreground">
            <span className="text-state-failed">Failed</span> and{" "}
            <span className="text-state-needs-input">needs input</span> are the only two states allowed to tint
            their own line of text — they are the only two a person has to act on.
          </p>
      </Section>

      <Section title="Subagents — one shape across harnesses">
          <div className="max-w-[760px]">
            <ActivityList items={SUBAGENT_SPECIMEN} onBeforeToggle={() => {}} />
          </div>
          <p className="mt-4 max-w-[760px] text-[11.5px] leading-relaxed text-muted-foreground">
            The harness adapter supplies identity and lifecycle; the conversation owns the shape. A compact summary
            answers who is working and whether it failed. Expand for the assignment, nested tools, child prose, and
            the exact issue. Parallel children remain sibling cards rather than being inferred from log adjacency.
          </p>
      </Section>

      <Section title="Diff">
          <div className="flex items-start gap-10">
            <div>
              <Eyebrow>Counts</Eyebrow>
              <div className="mt-2">
                <DiffStat adds={144} dels={77} />
              </div>
            </div>
            <div className="flex-1">
              <Eyebrow>Row tint — 10% α</Eyebrow>
              <div className="mt-2 overflow-hidden rounded-md font-mono text-[11px]">
                <div className="bg-diff-add-bg px-2 py-0.5 text-diff-add">+ if (!paletteOpen) return</div>
                <div className="bg-diff-del-bg px-2 py-0.5 text-diff-del">− document.addEventListener(…)</div>
                <div className="bg-card px-2 py-0.5 text-faint">14 unmodified lines</div>
              </div>
            </div>
          </div>
      </Section>

      <Section title="Type">
          <div className="grid grid-cols-2 gap-x-10 gap-y-6">
            <Specimen spec="Geist 24 / 600 / −1.8% · page titles only">
              <span className="text-[22px] font-semibold tracking-[-0.018em]">Graphite &amp; violet</span>
            </Specimen>
            <Specimen spec="Geist 16.5 / 600 / −1% · task header">
              <span className="text-[14.5px] font-semibold tracking-[-0.01em]">
                Fix the steer box swallowing cmd-enter
              </span>
            </Specimen>
            <Specimen spec="Geist 15 / 400 / 1.62 · agent prose, the widest measure">
              <Prose text="The palette now installs its key handler only while it is `open`, so the shortcut reaches the textarea in every state." />
            </Specimen>
            <Specimen spec="Geist 14.5 / 500 · list rows; controls use 14–15">
              <span className="text-[12.5px] font-medium">Terminal tab on the existing websocket</span>
            </Specimen>
            <Specimen spec="Geist 13.5 · one metadata line, never two">
              <Meta items={["droid", <span key="m" className="font-mono">kimi-k3</span>, "high effort", "Turn 3"]} />
            </Specimen>
            <Specimen spec="Geist 12.5 / 600 / +7.5% / uppercase · one per pane">
              <Eyebrow>Projects</Eyebrow>
            </Specimen>
            <Specimen spec="Geist Mono 13.5 · paths, ids, branches, diffs">
              <span className="font-mono text-[11.5px] text-muted-foreground">
                web/ui/src/components/<span className="text-foreground">steer-box.tsx</span>
              </span>
            </Specimen>
            <Specimen spec="Geist Mono 13 / 1.75 · step output">
              <span className="font-mono text-[11px] leading-[1.75] text-muted-foreground">
                $ bunx vitest run steer-box
                <br />
                &nbsp;&nbsp;7 passed (7)
              </span>
            </Specimen>
            <Specimen spec="Geist Mono 13.5 / 1.45 · terminal">
              <span className="font-mono text-[11.5px] leading-[1.45] text-muted-foreground">
                $ git status --short
              </span>
            </Specimen>
          </div>
      </Section>
    </>
  )
}

function InteractionSpecimens() {
  return (
    <>
      <Section title="The / palette — three tiers, one of them costs you">
          <div className="grid grid-cols-2 gap-10">
            <div>
              <Eyebrow>Typing · / on an empty draft</Eyebrow>
              <div className={cn("mt-2.5 w-full rounded-lg p-1", POPOVER_SURFACE)}>
                <SlashPaletteList groups={PALETTE_GROUPS} query="" onPick={() => {}} selectedValue="" />
              </div>
            </div>
            <div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Three tiers. <span className="text-fg-secondary">Wisp</span> is the daemon's own verbs — they cost
                nothing and never touch the model. Its <span className="font-mono">/tokens</span> report is persisted
                per-turn telemetry. The harness's name heads its own reads (
                <span className="font-mono">/context</span> and, where available,{" "}
                <span className="font-mono">/usage</span>): free, out-of-band claims Wisp relays. Familiar names keep
                the distinction clear: <span className="font-mono">/usage</span> is plan and limits, while{" "}
                <span className="font-mono">/tokens</span> is this task's recorded work.{" "}
                <span className="text-fg-secondary">Skills</span> are the harness's own registry, enumerated by the
                daemon (claude's init event, droid's list_skills, codex's skills/list) — never a hardcoded list that
                rots. Picking one only prefills the draft and the row says{" "}
                <span className="text-faint">runs a turn</span>; on codex the prefill is a plain-text ask with no fake
                slash, because codex has no headless <span className="font-mono">/name</span>.{" "}
                <span className="font-mono">compact</span> rides in the harness's own group (A5): the one entry among
                the free reads that COSTS, so it carries its own label —{" "}
                <span className="text-faint">runs a turn</span> where that is literally true (claude's is an ordinary
                recorded turn; codex's is a turn in codex's own thread),{" "}
                <span className="text-faint">costs tokens</span> where it isn't (droid summarizes without one). A
                failure names what failed and points at <span className="font-mono">/fresh</span>, which is the lever
                that always works. A tier with nothing to offer renders no heading at all — droid has no usage read,
                and a busy daemon's Skills is absent until the turn ends rather than filled with anything stale.
              </p>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Only the tier that costs something is marked. Labelling all three would put three badges in a list
                whose whole job is to be scanned, which is the chip ban wearing a new hat. Results land as one muted
                note above the composer, and a 409 lands there too — a refusal is an expected state, not an error.
              </p>
            </div>
          </div>
      </Section>

      <Section title="A read's answer is a report, not a bubble">
          <div className="grid grid-cols-2 gap-10">
            <div>
              <Eyebrow>The probe panel · a cached answer says so</Eyebrow>
              <div className="relative mt-2.5 h-[300px]">
                <ProbePanel
                  harness="droid"
                  command="context"
                  answer={PROBE_CONTEXT_ANSWER}
                  onClose={() => {}}
                  className="absolute inset-x-0 bottom-0"
                />
              </div>
            </div>
            <div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                Tier 2's answer floats above the composer in the popover surface, because claude's{" "}
                <span className="font-mono">/context</span> is a page of markdown and droid's is a breakdown table —
                neither fits a one-line note. Markdown renders as-is through Prose; structured numbers are tables
                Wisp owns the vocabulary of. An empty section renders NO section: the harness saying nothing is not a
                table with invented zeros.
              </p>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                <span className="text-faint">cached · 3 min ago</span> is marked because a cached number can be stale
                and staleness is news; a fresh answer says only when it was probed. A refusal never reaches this
                panel — it is the same muted note every command's refusal is. Escape or the × dismisses it, and a
                task switch never shows one task's report over another.
              </p>
            </div>
          </div>
      </Section>

      <Section title="Hover reveals exactly one verb">
          <div className="grid grid-cols-2 gap-10">
            <div>
              <Eyebrow>The row, with archive forced visible</Eyebrow>
              <div className="mt-2.5 rounded-lg border border-border bg-sidebar p-1.5">
                <div className="relative">
                  <div className="flex h-[26px] w-full items-center gap-2.5 rounded-md bg-hover pr-2 pl-2.5">
                    <StateDot state="done" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/90">
                      {TASKS[2]!.title}
                    </span>
                  </div>
                  <RowArchiveButton task={TASKS[2]!} onArchive={() => {}} className="opacity-100" />
                </div>
              </div>
            </div>
            <div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                One 22px control, in the git-marks slot, revealed by hover or by keyboard focus reaching the row — and
                the marks yield to it rather than sitting underneath. It is a SIBLING of the row's button, never a
                child: the row trigger is already a <span className="font-mono">&lt;button&gt;</span>, and a button
                inside a button is invalid HTML with genuinely broken clicks. The hover card suppresses while the
                pointer is over it, so two hover affordances never race over the same 280ms.
              </p>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                On touch there is no hover, so there is no control here: archive stays in the task header, where a
                finger already reaches it. A long press for one verb would be the app's only long press.
              </p>
            </div>
          </div>
      </Section>

      <Section title="Attachments — content, not status">
          <div className="grid grid-cols-2 gap-10">
            <div>
              <Eyebrow className="text-state-done">Keep — bare thumbnails</Eyebrow>
              <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">
                <div className="flex justify-end">
                  <div className="max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card px-3.5 py-2.5 text-[12.5px] leading-relaxed text-foreground/90">
                    why is the sidebar row cramped here?
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                  <SpecimenThumb label="1" />
                  <SpecimenThumb label="2" />
                </div>
              </div>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                A turn's images hang off its prompt bubble, because they are part of what the person sent. No frame, no
                count badge, no "2 attachments" label — the thumbnails are the content and they say their own number.
                Clicking one opens the presentation view at 80vw, which is a look rather than a mode: the app stays
                visible behind it.
              </p>
            </div>
            <div>
              <Eyebrow>Archived — the manifest outlives the bytes</Eyebrow>
              <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">
                <div className="flex justify-end">
                  <div className="max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card px-3.5 py-2.5 text-[12.5px] leading-relaxed text-foreground/90">
                    why is the sidebar row cramped here?
                  </div>
                </div>
                <div className="mt-1.5 flex justify-end">
                  <span className="max-w-[76%] truncate text-[11.5px] text-faint">
                    cramped.png, spacing.png — removed when this task was archived
                  </span>
                </div>
              </div>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Archive deletes the image bytes, so the turn keeps a record of what it carried and says the files are
                gone. A thumbnail that 410s and an empty space are the same lie in two costumes; this is the register
                the removed-worktree placeholders already use.
              </p>
            </div>
          </div>
      </Section>
    </>
  )
}

function WorkflowSpecimens() {
  return (
    <>
      <Section title="The shape to delete on sight">
          <div className="grid grid-cols-2 gap-10">
            <div>
              <Eyebrow className="text-state-failed">Kill — chips</Eyebrow>
              <div className="mt-2.5 rounded-lg border border-border bg-sidebar p-1.5">
                <div className="flex gap-2 rounded-md bg-hover p-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">fix the steer box swallo…</span>
                      <span className="rounded-full border border-[#4b7fd0] px-1.5 text-[9.5px] text-[#7ea3e2]">
                        running
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {["+144", "-77", "turn 3", "droid", "unpushed"].map((c) => (
                        <span
                          key={c}
                          className="rounded-full border border-border-strong px-1.5 text-[9.5px] text-muted-foreground"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                    <div className="mt-1 text-[10.5px] text-muted-foreground">
                      running — turn 3 of 3 · 2 dirty files · 1 ahead
                    </div>
                  </div>
                </div>
              </div>
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                Five chips, four hues, three lines of metadata and a lowercase title. Every fact is technically
                present and none of them is readable.
              </p>
            </div>
            <div>
              <Eyebrow>Pane header</Eyebrow>
              <div className="mt-2.5 overflow-hidden rounded-lg border border-border bg-sidebar">
                <PaneHeader>
                  <span className="text-[12.5px] font-medium">Changes</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">6</span>
                  <span className="flex-1" />
                  <Button size="sm" icon aria-label="Refresh">
                    <Refresh />
                  </Button>
                </PaneHeader>
                <div className="px-3.5 py-3 text-[11.5px] text-faint">
                  A label, not a tab — this pane has one view. It keeps a tab&#39;s shape so Checks can slot in
                  beside it later, but carries no underline and no hue.
                </div>
              </div>
            </div>
          </div>
      </Section>

      <Section title="Project settings — the worktree contract, one modal">
          <div className="flex flex-col gap-10">
            <div>
              <Eyebrow>A configured project</Eyebrow>
              <ProjectSettingsSpecimen project={REPOS[0]!} />
            </div>
            <div>
              <Eyebrow>A repo wisp only knows from task history — nothing set yet</Eyebrow>
              <ProjectSettingsSpecimen project={REPOS[1]!} />
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                All three fields are worktree-only, and the modal says so once at the top rather than three times.
                Every field is a PATCH — the display name it does not edit is preserved. The copy patterns resolve
                against the real repo and list what they take, debounced, because a glob is only trustworthy once you
                have seen its output. A configured project&apos;s Remove from Wisp is a two-click confirm; a
                history-only repo has no config entry to drop, so that control is absent.
              </p>
            </div>
          </div>
      </Section>

      <Section title="Metrics">
          <div className="flex flex-col gap-3.5">
            <MetricRow label="Radius">
              {[6, 8, 12].map((r) => (
                <span
                  key={r}
                  className="size-[26px] border border-border-strong"
                  style={{ borderRadius: `${r}px` }}
                />
              ))}
              <Rule />
              <span className="font-mono text-[11px] text-faint">6 · 8 · 12</span>
            </MetricRow>
            <MetricRow label="Control height">
              {[22, 26, 32].map((h) => (
                <span
                  key={h}
                  className="flex items-center rounded-md border border-border-strong px-2 text-[11px] text-muted-foreground"
                  style={{ height: `${h}px` }}
                >
                  {h}
                </span>
              ))}
            </MetricRow>
            <MetricRow label="Row height">
              <span className="font-mono text-[11px] text-faint">26 list · 34 pane header · 36 top bar</span>
            </MetricRow>
            <MetricRow label="Space">
              {[2, 4, 6, 8, 12, 18].map((w) => (
                <span key={w} className="h-[18px] bg-border-strong" style={{ width: `${w}px` }} />
              ))}
              <Rule />
              <span className="font-mono text-[11px] text-faint">2 4 6 8 12 18</span>
            </MetricRow>
          </div>
          <p className="mt-5 border-t border-border pt-4 text-[11.5px] leading-relaxed text-muted-foreground">
            Not a 4/8 grid. Dense tooling lives on odd numbers — a 26px row with 3px between its parts reads
            tighter and calmer than 32/4 does.
          </p>
      </Section>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>{title}</Eyebrow>
        <Rule />
      </div>
      <div className="rounded-xl border border-border bg-surface p-5">{children}</div>
    </section>
  )
}

function TextRow({ cls, name, note }: { cls: string; name: string; note: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className={`w-[300px] shrink-0 text-[13px] ${cls}`}>The quick brown fox jumps over</span>
      <span className="flex-1 text-[11px] text-muted-foreground">{note}</span>
      <span className="font-mono text-[10.5px] text-faint">{name}</span>
    </div>
  )
}

function Specimen({ spec, children }: { spec: string; children: ReactNode }) {
  return (
    <div>
      {children}
      <div className="mt-1.5 font-mono text-[11px] text-faint">{spec}</div>
    </div>
  )
}

function MetricRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[110px] shrink-0 text-[12px] text-fg-secondary">{label}</span>
      {children}
    </div>
  )
}
