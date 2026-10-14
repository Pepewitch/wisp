/**
 * What a reviewer reads before submitting its verdict. PURE ON PURPOSE, like
 * cli-help.ts: index.ts answers `review submit --help` from here before
 * anything loads config.
 */
import { wispCommand } from "./command"

const COMMAND = wispCommand()
const REVIEW_TOKEN_ENV = "WISP_REVIEW_TOKEN"

export const REVIEW_SUBMIT_HELP = `${COMMAND} review submit --stdin — what an auto-review reviewer runs, once, as its last step.

Reads one JSON object on stdin:
  verdict         "pass" | "fail" | "inconclusive"
  cause           with "inconclusive" only: "change" (the change kept you from verifying it)
                  or "recipe" (the project's verification recipe failed you)
  summary         what the PR does, in one or two sentences, at most 600 characters
  rationale       why your verdict, at most 2000 characters
  reviewed        the areas, files and behaviours you reviewed: at most 30, each at most 200 characters
  findings        a list, at most 20, each { "title", "severity", "lens", "detail"?, "file"?, "line"? }
                  severity: "blocking" (stops the merge) or "note"
                  lens: correctness, architecture, slop, security, performance, tests, docs,
                  or verification (the reviewer who runs the app)
                  a "fail" has at least one blocking finding; a "pass" has none
                  a blocker says what goes wrong (detail) and, on code, names its file
  recipeFeedback  what the recipe got wrong or lacks (required with cause "recipe")
  recipeArea      the recipe area that feedback is about, when there is one
  escalate        { "reason" }: on a light round, reviewer A asks for a second reviewer

Wisp adds the round's token (${REVIEW_TOKEN_ENV}, set only in a reviewer's turns) and
attaches every image you published with \`${COMMAND} output add\`. Reviewer B never uses
cause "recipe" or lens "verification". \`${COMMAND} review rubric\` prints the rubric.`
