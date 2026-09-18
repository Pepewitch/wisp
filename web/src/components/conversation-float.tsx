import { ArrowUp } from "@/components/icons"
import { StateDot } from "@/components/primitives"
import { cn } from "@/lib/utils"

/**
 * The one float the transcript is allowed, bottom-right, shown only when the
 * reader is not at the live end.
 *
 * It carries two meanings because they are the same meaning: "there is
 * something down there you are not looking at". When that something is a
 * questionnaire the agent is blocked on, the float says so and wears the
 * `needs-input` dot the sidebar row is already showing — a card scrolled out
 * of view is the one thing on screen genuinely waiting on a person.
 *
 * What it deliberately does NOT do is render a second copy of the form. Two
 * live forms for one request is a bug in waiting; this scrolls you to the one.
 */
export function ConversationFloat({
  waitingQuestions,
  onJump,
}: {
  waitingQuestions: number
  onJump: () => void
}) {
  const waiting = waitingQuestions > 0
  return (
    <button
      type="button"
      onClick={onJump}
      data-testid={waiting ? "questions-waiting" : "jump-to-latest"}
      className={cn(
        "absolute right-4 bottom-3 flex h-7 items-center gap-1.5 rounded-full border px-3",
        "text-[11.5px] shadow-float transition-colors",
        waiting
          ? "border-state-needs-input/45 bg-card text-foreground"
          : "border-border-strong bg-card text-fg-secondary hover:text-foreground",
      )}
    >
      {waiting ? (
        <>
          <StateDot state="needs-input" />
          {waitingQuestions === 1 ? "1 question waiting" : `${waitingQuestions} questions waiting`}
          <ArrowUp className="size-3 rotate-180" />
        </>
      ) : (
        <>
          <ArrowUp className="size-3 rotate-180" />
          Jump to latest
        </>
      )}
    </button>
  )
}
