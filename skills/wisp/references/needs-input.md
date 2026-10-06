# When a task needs input

`needs-input` means the task is waiting on you. Its `state_detail` says why
(`wisp ls` cuts it short; `wisp show` prints it in full):

- `turn N is asking you`: a Droid `AskUser` questionnaire. Turn N is still
  running, blocked until you answer, and has no result yet, so `wisp result`
  prints `(turn N is running, no result text)` or an older turn's answer.
  [Read the question](#read-an-open-question) from the raw stream.
- Starts with `turn interrupted`: someone stopped the turn and the session was
  kept. Send the next instruction.
- Anything else, or nothing: the turn ended needing you, and any detail is the
  start of its answer. Read `wisp result <id>`; if that does not say what the
  agent needs, [check the raw stream](#when-the-turn-has-ended).

## Read an open question

The rendered `wisp log` cuts the question short. Print the questionnaire
events from the raw stream instead:

```sh
wisp log <id> <N> --raw |
  jq -cR 'fromjson? | objects | select(.type == "question") | del(.type, .timestamp, .session_id)'
```

Each output line is one questionnaire event. An `asked` line carries the
`questions`, each with its `question`, its `options`, and whether it is
`multiSelect`. A later `answered` or `cancelled` line with the same `id`
closes it, so the open questionnaire is the `asked` line nothing closes.

Why `-R` and `fromjson?`: the raw stream is one JSON event per line, plus
plain-text lines Wisp writes into it (`· attached: …`, `· steer …`, a marker
where the middle of a long turn was not retained), and the tail that
`wisp log` reads without `-f` begins mid-record
([cli.md](cli.md#tasks)). Plain `jq` stops at the first line that is not JSON.
`-R` reads each line as text, `fromjson?` parses it or drops it, and `objects`
keeps only event objects.

The end of the transcript is enough here, because a turn blocked on a question
has written nothing since. Do not add `-f`: it follows a running turn until it
ends, and this one is waiting for you.

## When the turn has ended

- When Droid never hands Wisp a questionnaire it can show (an older Droid, or
  questions Wisp cannot render), Wisp ends the turn as `needs-input` instead
  of holding it open. No `question` event is recorded, but the agent's
  `AskUser` tool call holds the questionnaire text as `[question]`, `[topic]`,
  and `[option]` lines:

  ```sh
  wisp log <id> <N> --raw |
    jq -rR 'fromjson? | objects | select(.type == "tool_call" and .toolName == "AskUser") | .parameters.questionnaire'
  ```

- A Claude turn reads `needs-input` when its final `result` event lists
  denied tool calls:

  ```sh
  wisp log <id> <N> --raw | jq -cR 'fromjson? | objects | select(.type == "result") | .permission_denials'
  ```

If the end of the transcript does not reach back far enough, `--raw -f` prints
a settled turn's whole retained stream and then exits.

## Answer

```sh
wisp send <id> "1. Library ABC. 2. Keep the current API; the CLI depends on it."
```

On an open questionnaire, `send` releases it, recording each answer as
"(no selection — see the message that follows)", and delivers your message
into the same turn. The agent reads your words, not a selection, so give a
choice for every question. The browser and Desktop show the same
questionnaire as a card answered option by option. After a stopped or ended
turn, `send` starts the next turn in the same session.
