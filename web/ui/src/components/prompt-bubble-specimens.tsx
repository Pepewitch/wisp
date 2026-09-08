import type { ReactNode } from "react"

import { CopyButton } from "@/components/copy-button"
import { BubbleTimestamp, PersonBubble } from "@/components/person-bubble"
import { Eyebrow, Rule } from "@/components/primitives"

/**
 * The gallery's prompt-bubble specimens. They live outside `gallery.tsx` for
 * the same reason the connection and project-settings specimens do: that file
 * is the route, not a warehouse, and it sits at its maintainability cap.
 */

/** ~5½ minutes back, so the specimen reads "5 min ago" rather than "just now". */
const SENT_AT = new Date(Date.now() - 5.5 * 60_000).toISOString()

/** A stand-in for a real thumbnail: the gallery has no daemon to fetch bytes from. */
function SpecimenThumb({ label }: { label: string }) {
  return (
    <div className="flex size-14 items-center justify-center rounded-sm bg-border-strong font-mono text-[10.5px] text-muted-foreground">
      {label}
    </div>
  )
}

/**
 * The production bubble, so the specimens cannot drift from the transcript.
 * The gallery has no turn to render, only words and a caption.
 */
function SpecimenBubble({
  caption,
  actions,
  children,
}: {
  caption?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <PersonBubble caption={caption} actions={actions}>
      {children}
    </PersonBubble>
  )
}

/** What the bubble is, then when — the transcript's order and spacing. */
function SpecimenCaption({ exact = false, word }: { exact?: boolean; word?: string }) {
  return (
    <>
      {word && (
        <>
          <span className="whitespace-nowrap">{word}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <BubbleTimestamp at={SENT_AT} defaultExact={exact} />
    </>
  )
}

/** The floating toolbar, which the specimens show revealed. */
function SpecimenActions() {
  return <CopyButton text="specimen" label="Copy user message" copiedLabel="Copied user message" />
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

export function PromptBubbleSpecimens() {
  return (
    <>
      <Section title="Attachments — content, not status">
        <div className="grid grid-cols-2 gap-10">
          <div>
            <Eyebrow className="text-state-done">Keep — bare thumbnails</Eyebrow>
            <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">
              <SpecimenBubble>why is the sidebar row cramped here?</SpecimenBubble>
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
              <SpecimenBubble>why is the sidebar row cramped here?</SpecimenBubble>
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

      <Section title="Facts hang in the gutter, controls float above the corner">
        <div className="grid grid-cols-2 gap-10">
          <div>
            <Eyebrow>Both readings · either one is a click away</Eyebrow>
            <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">
              <SpecimenBubble caption={<SpecimenCaption />} actions={<SpecimenActions />}>
                can you make the timestamp readable at a glance?
              </SpecimenBubble>
              <div className="mt-[12px]">
                <SpecimenBubble
                  caption={
                    <>
                      <SpecimenCaption word="sent mid-turn" />
                    </>
                  }
                >
                  and say which of us started the turn
                </SpecimenBubble>
              </div>
              <div className="mt-[30px]">
                <SpecimenBubble caption={<SpecimenCaption exact />}>
                  and exact when I need to grep for it
                </SpecimenBubble>
              </div>
              {/* held to a phone's width, because that is when the rule fires */}
              <div className="mt-[30px] ml-auto max-w-[330px]">
                <SpecimenBubble caption={<SpecimenCaption exact />}>
                  and at a phone's width the caption drops below, still right-aligned
                </SpecimenBubble>
              </div>
            </div>
          </div>
          <div>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              The bubble holds the person's WORDS. What this bubble IS and when it was sent sit in the gutter to its
              left — the bubble is capped at 76%, so that space was already empty and the caption costs no height at
              all. Inside, they were a right-aligned row under left-aligned prose: two alignments in one box, and a
              line of chrome plus its gap where a short message had only three lines of text.
            </p>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              Relative by default, in the terse vocabulary the sidebar already speaks (
              <span className="text-faint">just now</span>, <span className="text-faint">5 min ago</span>,{" "}
              <span className="text-faint">3h ago</span>, <span className="text-faint">2d ago</span>), because that
              is the fact you want while a task is live and it survives 10.5px. It rides the app's one clock, so a
              live conversation runs one interval rather than one per bubble. Clicking swaps THAT bubble to the
              exact UTC instant, in mono — a machine wrote the string and you are about to paste it into a log
              search. The toggle is per bubble and never persists: asking when one message was sent is a question,
              not a preference.
            </p>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              A control is not a fact, so it is not in the caption. Copy floats on a small toolbar wholly above the
              bubble's top-right corner — clear of the edge rather than straddling it, because a three-control
              toolbar on a one-line bubble would otherwise sit on the words — and a pointer reveals it. Hover the
              first specimen to see it. A queued bubble's edit and cancel join it there. Every hidden state is
              <span className="text-faint"> pointer:</span>-gated, because touch has no hover and a control revealed
              only by one would be unreachable there.
            </p>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              One row reversed and allowed to wrap is the whole responsive story. A caption that no longer fits
              beside its bubble — a phone, or the exact instant, which is twice as wide as{" "}
              <span className="text-faint">5 min ago</span> — drops to its own line beneath rather than squeezing
              the words. A steer carries <span className="text-faint">sent mid-turn</span> there, because a settled
              turn shows its steers at the head of the turn and two right-aligned cards would otherwise look alike.
              A queued bubble has no caption at all: it has not been sent, so it has no time to state, and the line
              inside it already says the truer thing.
            </p>
          </div>
        </div>
      </Section>
    </>
  )
}
