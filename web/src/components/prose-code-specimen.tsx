import { Prose } from "@/components/prose"
import { Eyebrow, Rule } from "@/components/primitives"
import { cn } from "@/lib/utils"

/**
 * The gallery's code specimens: the three shapes markdown can hand us, on the
 * real renderer. They live outside `gallery.tsx` for the same reason the
 * prompt-bubble and update specimens do — that file is the route, not a
 * warehouse, and it sits at its maintainability cap.
 */

const INLINE = "One `--z-menu` token, one `cn()` call, and a `git rebase --onto` in a sentence."

const BARE_FENCE = [
  "```",
  "wisp task list --json | jq '.[] | .id'",
  "  tspace  running",
  "  tclock  needs-input",
  "```",
].join("\n")

const TAGGED_FENCE = [
  "```ts",
  "// the fence named a language, so the colour goes INSIDE the text",
  'export function slashGroups(task: ApiTask | null, limit = 12): SlashGroup[] {',
  '  if (!task) return []',
  '  return GROUPS.filter((group) => group.size > 0).slice(0, limit)',
  "}",
  "```",
].join("\n")

/** One fence per shape a turn actually carries, on the real renderer. */
const LANGUAGES: readonly { label: string; text: string }[] = [
  {
    label: "ts · the four roles in one line",
    text: ["```ts", 'const turns = await client.request<Turn[]>("/api/tasks", { limit: 12 })', "```"].join("\n"),
  },
  {
    label: "bash · what an agent runs",
    text: ["```bash", "#!/usr/bin/env bash", 'wisp task list --json | jq \'.[] | select(.state == "running")\'', "```"].join(
      "\n",
    ),
  },
  {
    label: "json · keys are names, values are quoted",
    text: ["```json", '{ "harness": "claude", "effort": "high", "turns": 3, "archived": false }', "```"].join("\n"),
  },
  {
    label: "sql",
    text: ["```sql", "select state, count(*) from tasks where archived = 0 group by state", "```"].join("\n"),
  },
  {
    label: "diff · borrows the changes pane's family",
    text: ["```diff", "--- a/steer-box.tsx", "+++ b/steer-box.tsx", "-  const busy = false", "+  const busy = sending", "```"].join(
      "\n",
    ),
  },
  {
    label: "python",
    text: ["```py", "def promote(version: str, *, dry_run: bool = False) -> None:", '    print(f"promoting {version}")', "```"].join(
      "\n",
    ),
  },
]

/** Literal class names, never `bg-syntax-${name}` — a template generates nothing. */
const ROLES: readonly { name: string; dot: string; text: string; role: string }[] = [
  { name: "keyword", dot: "bg-syntax-keyword", text: "text-syntax-keyword", role: "what the language reserves" },
  { name: "string", dot: "bg-syntax-string", text: "text-syntax-string", role: "what is quoted" },
  { name: "number", dot: "bg-syntax-number", text: "text-syntax-number", role: "a literal value" },
  { name: "entity", dot: "bg-syntax-entity", text: "text-syntax-entity", role: "what has a name" },
  { name: "comment", dot: "bg-syntax-comment", text: "text-syntax-comment", role: "an aside, italic" },
]

export function ProseCodeSpecimen() {
  return (
    <section className="mt-9">
      <div className="mb-4 flex items-center gap-3">
        <Eyebrow>Code — a chip in a sentence, a surface on its own</Eyebrow>
        <Rule />
      </div>
      <div className="grid grid-cols-2 gap-10">
        <div className="space-y-5">
          <div>
            <Eyebrow>Inline · one backtick</Eyebrow>
            <div className="mt-2 rounded-lg border border-border bg-surface p-3">
              <Prose text={INLINE} />
            </div>
          </div>
          <div>
            <Eyebrow>A fence with no language · plain</Eyebrow>
            <div className="mt-2 rounded-lg border border-border bg-surface p-3">
              <Prose text={BARE_FENCE} />
            </div>
          </div>
          <div>
            <Eyebrow>A fence that named one</Eyebrow>
            <div className="mt-2 rounded-lg border border-border bg-surface p-3">
              <Prose text={TAGGED_FENCE} />
            </div>
          </div>
        </div>
        <div>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            Markdown hands both of these to a <span className="font-mono text-faint">code</span> element, and the only
            thing that tells them apart is the{" "}
            <span className="font-mono text-faint">language-*</span> class a fence gets when it names a language.
          </p>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            <strong className="font-semibold text-foreground">Inline code is a chip</strong> — a violet wash and accent
            text, one of the five places the accent is spent (§1). It is a phrase inside a sentence, so it needs to be
            picked out of running prose without becoming a surface of its own.
          </p>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            <strong className="font-semibold text-foreground">A block is a surface</strong> — plain mono on{" "}
            <span className="font-mono text-faint">--code</span>, one step above the reading column. It already says
            "this is code" with its fill, its border and its face, so it spends no hue on saying it again. A bare fence
            used to take the inline branch and wear the chip around the whole block: pill fill and accent text on top of
            this surface, which read as two code styles at once.
          </p>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
            Naming a language changes what happens INSIDE the text and nothing about the box.
          </p>
          <div className="mt-4 space-y-1.5">
            {ROLES.map((role) => (
              <div key={role.name} className="flex items-baseline gap-2 text-[11.5px]">
                <span aria-hidden className={cn("size-2 shrink-0 translate-y-[3px] rounded-full", role.dot)} />
                <span className={cn("font-mono text-[11px]", role.text)}>{role.name}</span>
                <span className="text-faint">{role.role}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            Five roles, not one theme per language: one map answers every language highlight.js knows. Four of them sit
            at one lightness and one chroma, BELOW the accent's, so a code block never out-colours the one violet the
            app spends on the send button and the running dot. Identifiers, parameters and punctuation stay plain —
            they are most of a line, and if everything is coloured nothing is.
          </p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-5">
        {LANGUAGES.map((language) => (
          <div key={language.label}>
            <Eyebrow>{language.label}</Eyebrow>
            <div className="mt-2 rounded-lg border border-border bg-surface p-3">
              <Prose text={language.text} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
