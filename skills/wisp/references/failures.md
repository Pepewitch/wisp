# Stuck, failed, or exited

Tasks never silently succeed: a bare exit 0 with no parsed result is recorded
as a failure. Trust the state and its `state_detail`, not hopes.

## stuck

`no output for N min (turn T)` means the running turn has written nothing for
`stuckMinutes` (10 by default). This kind of stuck is reversible: the task
returns to `running` once output resumes, and `wisp wait` keeps waiting
through it. A quiet turn is often a long build or test run: read
`wisp show <id>` and the end of `wisp log <id>` before acting, and interrupt
(`wisp interrupt <id>`) only a turn that is looping or hung.

`Could not fully stop turn …` is a Stop that did not finish. That task does
not return to `running` by itself, and `wisp wait` waits on it until its
timeout. Fix what the detail reports, then run `wisp interrupt <id>` again;
sending and archiving are refused until the Stop completes. While a Stop is
still in progress, the task reads `running` with a detail that starts
`Stopping turn`.

## failed

`state_detail` names the cause. Two prefixes change what to do:

- `limit: ` is a usage or rate limit. `wisp limits` shows each harness's plan
  windows: wait for the window to reset and then `wisp send <id> "continue"`,
  or [move the work](supervise.md#steering) to another harness or model.
- `transient: ` is a provider or stream fault that is safe to retry a few
  times: `wisp send <id> "continue"`.

Otherwise the detail says how the turn ended: `turn exited N: …` with the
harness's last words, `turn reported failure: …`, `turn killed: …`, or
`turn exited 0 but emitted no parseable result`. Fix what it names, then send
a follow-up; the next turn continues in the same session.

## exited N

`exited N` is the word `wisp ls` and `wisp show` use for a failed task whose
latest turn had already delivered its result when its harness CLI exited with
code N. The state is still `failed`, so `wisp wait` exits 1, and its
`state_detail` reads as under [failed](#failed). The work may be complete:
read `wisp result <id>` and review the diff before redoing anything.
