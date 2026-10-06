# Stuck, failed, or exited

Tasks never silently succeed: a bare exit 0 with no parsed result is recorded
as a failure. Trust the state and its `state_detail`, not hopes.

## stuck

`stuck` is reversible, and `wisp wait` keeps waiting through it.
`no output for N min (turn T)` means the running turn has written nothing for
`stuckMinutes` (10 by default); the task returns to `running` once output
resumes. A quiet turn is often a long build or test run: read `wisp show <id>`
and the end of `wisp log <id>` before acting, and interrupt
(`wisp interrupt <id>`) only a turn that is looping or hung.

A detail that starts `Stopping turn` or `Could not fully stop turn` is a Stop
that has not finished. Sending and archiving are refused until it does:
resolve what the detail reports, then run `wisp interrupt <id>` again.

## failed

`state_detail` names the cause. Two prefixes change what to do:

- `limit: ` is a usage or rate limit. `wisp limits` shows each harness's plan
  windows: wait for the window to reset, or move the work to another harness
  or model.
- `transient: ` is a provider or stream fault that is safe to retry a few
  times: `wisp send <id> "continue"`.

Otherwise the detail says how the turn ended: `turn exited N: …` with the
harness's last words, `turn reported failure: …`, `turn killed: …`, or
`turn exited 0 but emitted no parseable result`. Fix what it names, then send
a follow-up; the next turn continues in the same session.

## exited N

`exited N` is the word `wisp ls` and `wisp show` use for a failed task whose
latest turn had already delivered its result when its harness CLI exited with
code N. The state is still `failed`, so `wisp wait` exits 1. The work may be
complete: read `wisp result <id>` and review the diff before redoing anything.
