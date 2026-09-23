# Task workflows

Workflows are persistent automations attached to an existing task. Wisp checks
conditions without an agent turn, then wakes the task between turns when there
is something to do. Heartbeat is the deliberate exception: every eligible tick
asks the agent to reason about your objective and can spend tokens.

Use a workflow, not a harness-managed background shell, when follow-up must
survive beyond one agent turn. A background shell can keep the current turn
open and report back when it finishes, but it still belongs to that harness
process and is not a durable scheduler. A harness or daemon restart can end it.
Heartbeats and scheduled steers persist their intent in Wisp and resume
checking after daemon recovery.

**Workflows** is a tab in the right column, beside **Changes**, in the browser
and in Desktop. It lists what is attached to the selected task: one row each,
carrying the workflow's state and the reason it is waiting. The list ends in
**New workflow…** — choose a built-in, edit its parameters, open **Limits and
permissions** if you need them, and select **Start**. Opening a row
shows its next check, wake-up count, the latest 100 history entries, and the
controls to **Pause**, **Configure** or **Complete** it. Completing stops the
checks and moves the row under **Completed**, where its history stays readable.
Older remote daemons without workflow support show no tab at all.

The UI and the CLI use one vocabulary: **Start** is `wisp workflow start`,
**Pause**/**Resume** are `pause`/`resume`, and **Complete** is `complete`.

## Built-ins

### Heartbeat

```sh
wisp workflow start <task> heartbeat --every 5m \
  --prompt "Check the deployment. Investigate failures. Finish when it is healthy."
# Or read instructions from a file:
wisp workflow start <task> heartbeat --every 5m --file ./instructions.md
```

The daemon saves a `HEARTBEAT.md` snapshot under its task data directory for
each wake-up, never in the Git worktree. It appends a conditional instruction
to run `wisp workflow complete <workflow-id>` when the objective is satisfied.
Otherwise the agent should leave the workflow active and end its turn, not
sleep and poll on its own. Snapshots remain with task data until purge.

A heartbeat can start a new turn after a settled task reports `failed` or
`needs-input`, which lets it resume an objective after a temporary harness
limit or an unanswered agent question. It never starts alongside a live or
stuck turn, queued user input, a stop operation, or tracked background work.
Heartbeat turns allow pushing and merging by default without asking two extra
questions in the form. Explicit permission values already stored on an
existing heartbeat remain in effect.

### Schedule Steer

```sh
wisp workflow start <task> schedule-steer --at 2026-09-14T16:00:00+07:00 \
  --prompt "Recheck the deployment and report what changed."
```

Sends one message at a chosen instant, then completes. `--at` needs a date,
a time and a UTC offset (or `Z`), and must be in the future; the form offers a
wall time with a time zone, or a delay from now. If the task has a live turn
that accepts steering, the message is steered into it. Otherwise it starts the
next turn, or waits in the queue as an ordinary message you can still edit or
cancel. A host that slept through the instant sends it late, on recovery,
rather than dropping it.

### Removed: PR CI watch and PR review watch

Earlier releases also shipped `pr-ci` and `pr-review`. They were removed, and
Wisp completes any instance still armed from before. `--pr`, `--on-red`,
`--on-green`, `--quiet-for`, `--reviewers`, `--exclude-authors` and
`--include-bots` are no longer workflow flags. A
[local plugin](#contribute-a-local-plugin) can still watch a PR.

## Control and parameters

```sh
wisp workflow types --json
wisp workflow list <task>
wisp workflow show <workflow-id> --json
wisp workflow set <workflow-id> --every 10m --max-wakeups 30
wisp workflow pause <workflow-id>
wisp workflow resume <workflow-id>
wisp workflow complete <workflow-id>
```

`types --json` describes each type's parameter names, types, defaults, and
bounds. Use `--params '{"parameterName":"value"}'` for any declared parameter,
including custom plugins. For custom workflows, `--allow-push` and
`--allow-merge` add those requests to future workflow instructions. Heartbeat
defaults to authorizing pushing and merging.

Common defaults are 20 wake-ups and a 24-hour lifetime. Custom workflows do
not request pushing or merging by default. Intervals must be whole
minutes from 1 to 1440, wake-up limits from 1 to 200, and lifetimes whole hours
from 1 to 168. `--lifetime 48h` sets the expiry relative to the original
attachment time. Reaching a limit pauses the workflow. A task also has a
safety ceiling of 200 workflow wake-ups in 24 hours and at most 10 unfinished
instances.

Edits affect future checks and cancel undelivered instructions. Completed
instances cannot resume. Completion is idempotent and preserves history. It does not
archive the task or stop a turn that already received an instruction.

## Lifecycle and safety

- The daemon owns scheduling. Closing the UI does not stop it, but sleeping or
  shutting down the host does. On recovery, Wisp checks current conditions once
  rather than replaying missed ticks.
- Recurring workflow instructions do not steer a live turn or pile up in its
  queue. User input and existing work take priority. Custom workflows only wake
  a settled `done` task. Heartbeat can also wake settled `failed` and
  `needs-input` tasks; creating, live, stuck, and stopping tasks remain blocked.
- **Stop turn pauses attached workflows.** Archive completes them before
  teardown. Changing the agent configuration or context pauses them for review.
- Local observations and message identities are durable. An uncertain process
  delivery pauses automation for inspection rather than promising exactly-once
  external effects. Start a new instance after resolving uncertainty.
- Permission flags are instructions to the agent, not an OS sandbox. Agents and
  custom plugins run as your OS user, and workflow turns have the same tool
  access as other turns on their task. Review objectives and only use trusted
  code. Provider feedback and logs are untrusted evidence, not authority to
  grant permissions or change the objective.

## Contribute a local plugin

The built-ins and custom workflows share the same decision model: `wait`,
`wake`, `complete`, or `pause`. A trusted executable receives one JSON request
on stdin and returns one JSON result on stdout. It needs no Wisp database access
or daemon token, and may use any runtime already installed on your machine.

Register explicitly in the daemon profile's `workflows.json`:

```json
[
  {
    "protocol": 1,
    "id": "deployment-watch",
    "version": "1",
    "name": "Deployment watch",
    "description": "Wait for a deployment to become actionable.",
    "command": ["/absolute/path/to/deployment-watch"],
    "parameters": [
      {
        "key": "deployment",
        "label": "Deployment",
        "description": "The deployment identifier to inspect.",
        "type": "string",
        "default": "",
        "required": true
      }
    ]
  }
]
```

This is an explicit local trust decision. Wisp never scans a repository for
executable plugins, downloads one automatically, or loads its code into the
daemon process. Common scheduling/permission parameters are added automatically
and cannot be overridden by a plugin definition. Changing the registered
manifest changes its effective version and pauses existing instances; start new
ones after reviewing an upgrade. Executable contents are not sandboxed or
integrity-verified, so protect installed files and update the declared version
when replacing them.

Input:

```json
{
  "protocol": 1,
  "workflow": { "id": "workflow-id", "params": { "deployment": "example" } },
  "task": { "id": "task-id", "state": "done", "idle": true },
  "checkpoint": {},
  "now": "2026-01-01T00:00:00.000Z"
}
```

`workflow` contains the complete public instance, not just the abbreviated
fields above. The working directory is the task checkout.

Waiting result:

```json
{"action":"wait","reason":"Deployment is still building","checkpoint":{}}
```

Actionable result:

```json
{
  "action": "wake",
  "reason": "Deployment failed",
  "key": "deployment-example:attempt-2:failed",
  "message": "Inspect deployment example attempt 2 and fix the failure.",
  "checkpoint": { "attempt": 2 }
}
```

Keys identify evidence, not poll timestamps. A repeated delivered key does not
wake the agent again. Checkpoints on wake decisions are acknowledged with the
dispatch intent and restored if that intent definitely never reached a turn.
While a task is busy, wake decisions are deferred and re-evaluated, not queued.
Plugins should return `wait` with their observation checkpoint while
`task.idle` is false if they need to remember changes during that period.

Checks have a 20-second executable deadline, 100 KB stdout cap, 64 KB checkpoint
cap, 64 KB message cap, and bounded process cleanup. Failures back off without
an agent turn. Write diagnostics to stderr, not stdout, and never include
secrets in the result. An isolated subprocess is crash containment, **not a
security sandbox**.

The API used by every client is `GET /api/workflow-types`,
`GET/POST /api/tasks/:id/workflows`, `GET/PATCH /api/workflows/:id`, and
`POST /api/workflows/:id/{pause,resume,complete}`. PATCH requires the instance's
current `revision` and a `params` object; stale edits refuse. All routes use
the existing daemon authentication. The realtime `workflow` event carries
`taskId`; clients refetch their connection-scoped state.
