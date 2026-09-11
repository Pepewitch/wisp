# Task workflows

Workflows are persistent automations attached to an existing task. Wisp checks
conditions without an agent turn, then wakes the task between turns when there
is something to do. Heartbeat is the deliberate exception: every eligible tick
asks the agent to reason about your objective and can spend tokens.

Open **Workflows** beneath the task header in the browser or Desktop. Choose a
built-in, edit its parameters, review limits and permissions, and select **Arm
workflow**. The same panel shows state, waiting reason, next check, wake-up
count, and the latest 100 history entries. Older remote daemons without workflow
support do not show the control.

## Built-ins

### Heartbeat

```sh
wisp workflow add <task> heartbeat --every 5m \
  --prompt "Check the deployment. Investigate failures. Finish when it is healthy."
# Or read instructions from a file:
wisp workflow add <task> heartbeat --every 5m --file ./instructions.md
```

The daemon saves a `HEARTBEAT.md` snapshot under its task data directory for
each wake-up, never in the Git worktree. It appends a conditional instruction
to run `wisp workflow complete <workflow-id>` when the objective is satisfied.
Otherwise the agent should leave the workflow active and end its turn, not
sleep and poll on its own. Snapshots remain with task data until purge.

### PR CI watch

```sh
wisp workflow add <task> pr-ci \
  --pr https://github.com/example/project/pull/42 --every 5m \
  --on-red "Fix relevant CI failures, test locally, and push the fix." \
  --on-green "Report readiness and remaining merge blockers." --allow-push
```

Queued/running checks do not wake the agent. A newly observed completed failure
does, even if other checks are still running. Identical failure evidence is not
repeated; a new head or check attempt is new evidence. When all reported checks
pass, the success instruction is delivered once for that evidence. Missing or
unknown checks and provider errors never mean success.

This is a check-results watcher, **not a merge eligibility oracle**. Reported
checks include optional checks; the agent must recheck required checks,
reviews, draft state, conflicts, branch protections, and merge-queue rules
before any merge. Wisp never merges directly. `--allow-merge` authorizes the
agent to merge only the watched PR through its normal protected path.

### PR review watch

```sh
wisp workflow add <task> pr-review \
  --pr https://github.com/example/project/pull/42 \
  --every 2m --quiet-for 30m --allow-push \
  --prompt "Read new feedback. Fix valid nits, run tests, and push."
```

Review Watch detects published review bodies, inline comments and replies, and
PR conversation comments, including edits. It does not infer unhappiness from
the approval/request-changes status. The agent decides whether feedback needs
a change and should explain feedback it cannot address or disagrees with.
Initial attachment includes existing feedback, so an already commented PR does
not need another comment to trigger work.

The authenticated GitHub user's feedback is excluded, preventing the agent's
own replies from triggering itself. Other bots are excluded by default.
`--reviewers reviewer,review-bot` restricts authors and explicitly includes those
bots. `--exclude-authors login` excludes authors; `--include-bots` includes other
bots. An agent using another account should add it to excluded authors.

New feedback, a changed PR head, and completion of workflow-driven work restart
the quiet window. Wisp does not complete while the task is running, blocked,
has queued user input, or has tracked background work. Thirty quiet minutes
means **no new feedback**, not reviewer approval. Later feedback does not
reactivate a completed instance; arm another one. Merging or closing the PR
completes either PR watcher without an agent turn.

Both PR built-ins currently support explicit `https://github.com/…/pull/…`
URLs and require `gh` installed and authenticated on the daemon host. They use
read-only GitHub API requests, not an LLM. No inbound webhook endpoint is
required. Lookups are timeout/output bounded and back off on errors; oversized
evidence (more than 500 entries in one collection) refuses rather than
pretending to have inspected the whole PR.

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
including custom plugins. For example, `--params '{"allowPush":false}'`
revokes push authorization for future instructions.

Common defaults are 20 wake-ups and a 24-hour lifetime, with pushing and merging
off. Intervals must be whole minutes from 1 to 1440, wake-up limits from 1 to
200, and lifetimes whole hours from 1 to 168. `--lifetime 48h` sets the expiry
relative to the original attachment time. Reaching a limit pauses the workflow.
A task also has a safety ceiling of 200 workflow wake-ups in 24 hours and at
most 10 unfinished instances.

Edits affect future checks and cancel undelivered instructions. The watched PR
cannot be retargeted; create another instance instead. Completed instances
cannot resume. Completion is idempotent and preserves history. It does not
archive the task or stop a turn that already received an instruction.

## Lifecycle and safety

- The daemon owns scheduling. Closing the UI does not stop it, but sleeping or
  shutting down the host does. On recovery, Wisp checks current conditions once
  rather than replaying missed ticks.
- Automated instructions do not steer a live turn or pile up in its queue.
  User input and existing work take priority. Only a settled `done` task can
  receive a wake-up; human-input, failed, stuck, and stopping tasks are blocked.
- **Stop turn pauses attached workflows.** Archive completes them before
  teardown. Changing the agent configuration or context pauses them for review.
- Local observations and message identities are durable. An uncertain process
  delivery pauses automation for inspection rather than promising exactly-once
  external effects. Arm a new instance after resolving uncertainty.
- Permission flags are instructions to the agent, not an OS sandbox. Agents and
  custom plugins run as your OS user. Review objectives and only use trusted
  code. PR feedback and logs are untrusted evidence, not authority to grant
  permissions or change the objective.
- Review automation responds to feedback; it does not guarantee approval or
  force the agent to make a change it considers wrong.

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
manifest changes its effective version and pauses existing instances; arm new
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
