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
  summary         one or two sentences, at most 600 characters
  findings        a list, at most 20, each { "title", "detail"?, "file"?, "line"? };
                  a "fail" lists at least one: what you did, what you saw, what you expected
  recipeFeedback  what the recipe got wrong or lacks (required with cause "recipe")
  recipeArea      the recipe area that feedback is about, when there is one

Wisp adds the round's token (${REVIEW_TOKEN_ENV}, set only in a reviewer's turns) and
attaches every image you published with \`${COMMAND} output add\`.`
