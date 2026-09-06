import type { ReactNode } from "react"

import { BubbleTimestamp } from "@/components/conversation"
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

/** The prompt bubble's anatomy, rebuilt: the gallery has no turn to render. */
function SpecimenBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[76%] rounded-xl rounded-br-[4px] border border-border bg-card px-3.5 py-2.5 text-[12.5px] leading-relaxed text-foreground/90">
        {children}
      </div>
    </div>
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

      <Section title="When a bubble was sent — a question, not a mode">
        <div className="grid grid-cols-2 gap-10">
          <div>
            <Eyebrow>Both readings · either one is a click away</Eyebrow>
            <div className="mt-2.5 rounded-lg border border-border bg-surface p-3">
              <SpecimenBubble>
                can you make the timestamp readable at a glance?
                <BubbleTimestamp at={SENT_AT} className="mt-1.5 ml-auto block w-fit" />
              </SpecimenBubble>
              <div className="mt-[30px]">
                <SpecimenBubble>
                  and exact when I need to grep for it
                  <BubbleTimestamp at={SENT_AT} defaultExact className="mt-1.5 ml-auto block w-fit" />
                </SpecimenBubble>
              </div>
            </div>
          </div>
          <div>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              Every bubble the person SENT carries when, as its own last muted line — a prompt bubble from the turn's
              start, a steer from the message. Relative by default, in the terse vocabulary the sidebar already
              speaks (<span className="text-faint">just now</span>, <span className="text-faint">5 min ago</span>,{" "}
              <span className="text-faint">3h ago</span>, <span className="text-faint">2d ago</span>), because that
              is the fact you want while a task is live and it survives 10.5px. It rides the app's one clock, so a
              live conversation runs one interval rather than one per bubble.
            </p>
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
              Clicking swaps THAT bubble to the exact UTC instant, in mono — because a machine wrote the string and
              you are about to paste it into a log search. The toggle is per bubble and never persists: asking when
              one message was sent is a question, not a preference, so it neither drags its neighbours along nor
              survives a reload. A queued bubble has no timestamp at all — it has not been sent, and its line already
              says the truer thing.
            </p>
          </div>
        </div>
      </Section>
    </>
  )
}
