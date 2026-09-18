import { Eyebrow } from "@/components/primitives"
import { QuestionnaireCard } from "@/components/questionnaire-card"
import { QUESTIONNAIRE_SPECIMENS } from "@/components/gallery-fixtures"

/** Every state a questionnaire can be read in, pending first. */
export function QuestionnaireSpecimens() {
  return (
    <>
      <div className="max-w-[560px]">
        {QUESTIONNAIRE_SPECIMENS.map(({ label, item }) => (
          <div key={item.id} className="mb-6 last:mb-0">
            <Eyebrow>{label}</Eyebrow>
            <QuestionnaireCard item={item} state="pending" harness="droid" onSubmit={() => {}} />
          </div>
        ))}
      </div>
      <p className="mt-4 max-w-[760px] text-[11.5px] leading-relaxed text-muted-foreground">
        Every question at once, one Send — the harness's own TUI asks them one at a time because a
        terminal cannot scroll comfortably; this can. A chosen option takes the SELECTED background and
        never hue, so the card's one violet stays on Send, the same rule the composer already lives by.
        Shape carries the rule the words repeat: a circle is choose-one, a square is choose-any. The
        own-answer row is the last row of the same list, because every harness with this tool guarantees
        one and none of them list it. Answering is never required — the composer stays live, and a
        message sent instead settles the card as superseded rather than leaving a Send button that
        resolves nothing.
      </p>
      <p className="mt-3 max-w-[760px] text-[11.5px] leading-relaxed text-muted-foreground">
        Two deliberate exceptions, recorded here so they stay rules rather than drift. The pending
        card is the one CONTAINER allowed a state hue on its border — everywhere else{" "}
        <span className="text-state-needs-input">needs-input</span> is a 6px dot or a line of text —
        because it is the one container the agent is blocked on, and a dot alone does not find it
        when you scroll back through forty turns. And its Send may be violet at the same time as the
        composer's: <span className="font-mono">index.css</span> lists the send button as its own
        place the accent may go, and when a card is answered and a message is typed there really are
        two sendable things.
      </p>
    </>
  )
}
