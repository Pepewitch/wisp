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
closes it. The open questionnaires are the `asked` lines nothing closes;
subagents can ask too, so there may be several, and one `send` answers them
all.

Why `-R` and `fromjson?`: the raw stream is one JSON event per line, plus
plain-text lines Wisp writes into it (`· attached: …`, `· steer …`, a marker
where the middle of a long turn was not retained), and the tail that
`wisp log` reads without `-f` begins mid-record
([cli.md](cli.md#tasks)). Plain `jq` stops at the first line that is not JSON.
`-R` reads each line as text, `fromjson?` parses it or drops it, and `objects`
keeps only event objects.

That tail is usually enough, because a turn blocked on a question writes
little after it. If nothing prints, check `wisp ls` again: the question may
have been answered meanwhile. If the task is still asking,
[read further back](#read-further-back).

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

## Read further back

When the tail does not reach the event, save the turn's whole retained stream
to a file, then run the recipe's `jq` command with the file as its last
argument. `--raw -f` prints the stream from its start and exits once a settled
turn's stream ends; a turn still blocked on a question has not ended, so stop
it after a few seconds:

```sh
f="${TMPDIR:-/tmp}/turn.jsonl"
wisp log <id> <N> --raw -f > "$f"                      # a settled turn: exits by itself
wisp log <id> <N> --raw -f > "$f" & sleep 5; kill $!   # a turn still asking
```

Redirect to a file, not a pipe ([cli.md](cli.md#tasks) says why).

## Answer

Answer only what the task's prompt or the user has already settled. Relay any
other question to the user with its options, and send their reply.

```sh
wisp send <id> "1. Library ABC. 2. Keep the current API; the CLI depends on it."
```

On an open questionnaire, `send` releases it, recording each answer as
"(no selection — see the message that follows)", and delivers your message
into the same turn. The agent reads your words, not a selection, so give a
choice for every question. The browser and Desktop show the same
questionnaire as a card answered option by option. After a stopped or ended
turn, `send` starts the next turn in the same session.
