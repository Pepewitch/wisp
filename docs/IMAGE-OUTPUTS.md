# Image outputs

A turn's images come in two kinds, and Browser and Desktop show them apart:

- **Shown to you** (`published`): images the agent chose to share with
  `wisp output add` or `wisp capture`, and images a Codex agent generated.
  They appear below the turn's reply, each captioned with the step that
  shared it (`from: wisp output add before.png`, `from: image generation`).
- **Looked at** (`native`): images a tool showed the agent, such as reading a
  screenshot. They do not pile up after the reply. The collapsed steps row
  counts them (`looked at 8 images`); expanding the steps shows each one under
  the step that produced it. An image whose step is not in the timeline shows
  at the end of the steps.

Click an image to expand it; Download saves the original bytes, using a
native Save panel in Desktop and a browser download in Browser. Images use
the active daemon connection's authenticated asset transport. When a turn's
transcript has been evicted, every image is listed below the reply instead.

## Publishing a file

Any harness can publish an image it created:

```sh
wisp output add ./plot.png --turn 1
```

Inside a task, the task ID defaults to `WISP_TASK_ID`. Outside it, pass
`--task <task>`. Wisp gives each ordinary turn the command with its current
turn number. A relative path resolves in the caller's working directory;
the CLI uploads the bytes, so it also works when the daemon is on another
machine. Publishing copies the file into task storage and leaves the original
alone. Publish only images intended for the task's readers.

PNG, JPEG, GIF and WebP are supported. Each image is limited to 8 MiB, and
each turn to 32 distinct images and 64 MiB. Content is sniffed from bytes;
file extensions and tool MIME declarations do not authorize other formats.
Identical bytes on the same turn produce one output. SVG and arbitrary local
file references are not loaded automatically.

## Native tool images

Wisp captures the images a harness showed its agent, before transcript
bounding, and names each after the file its tool call read (`image.<ext>`
when there was none):

| harness | what is captured |
|---|---|
| Claude | base64 image parts of a `tool_result`, e.g. from `Read`; the bytes are replaced in the transcript |
| Droid | base64 image parts of a `tool_result`, e.g. from `Read`; the bytes are replaced in the transcript |
| Codex | MCP image content; `image_view` files (copied from their path); `image_generation` results, recorded as **shared** since the agent made them for you (the whole base64 `result`, captured before the transcript is bounded; the copy in Codex's own home is not read) |
| Cursor | image files read by `readToolCall` (copied from their path once the turn ends, and only if unchanged since that read) |
| OpenCode | data-URL image attachments on a completed `read` tool |

Codex and Cursor report only a path, so Wisp copies the file. It resolves the
path first (following symlinks) and copies only a regular file, within the
per-image limit, that is inside one of:

- the task's worktree;
- the task's own Wisp files (its attachments and outputs);
- the OS temp directory or `/tmp`, unless that place is also inside the Wisp
  home.

Anything else, including the rest of the Wisp home, is refused. Cursor and
OpenCode write their output straight to the log, so Wisp reads their events
only once the turn ends. A Cursor read is then given the file only if the
file was last modified no later than the read completed (the event's
`completedAtMs`); otherwise its bytes may not be what that step saw, and the
activity says the file changed after it was read. A path read twice
therefore gives at most its last read the image. A refusal,
an invalid image or a failed write adds an `Image output unavailable: <why>`
line to the activity while the agent continues. A captured image leaves an
`Image output: <name> (<bytes>; <id>)` line in its place in the log and the
raw transcript; the web hides that line where the image itself shows under
its step. Other native image event
types are not inferred from arbitrary tool JSON; publish those files with
`wisp output add`. HTTP(S) Markdown images retain their existing
click-to-load behavior.

Publishing bytes the agent already looked at turns that image into a shared
one, from the step that shared it.

To screenshot an app the agent launched, `wisp capture <url>` has Wisp take
the shot in its own headless Chrome and store it here as a published image,
with a record of what it saw ([wisp capture](CAPTURE.md)).

Inline native capture remains subject to the harness protocol's 16 MiB frame
limit. For a tool result containing several large images, publish the
individual files instead.

## Steps

Each image records the step it came from, as `step: {id, label}` in the
turn's `outputs` (`GET /api/tasks/<id>/outputs/<turn>` and every turn in the
task API). `id` is the tool call id the turn's activity timeline gives that
step; `label` names it (`Read /work/clip.png`, or a command step's command).
A native image's step is the tool call that produced it. A published image's
step is the command step that published it: among the command steps running
when it arrives, the one whose command is `wisp output add` naming that
file's name, or for `wisp capture` the only running capture. When no running
step matches, or several do (parallel calls publishing the same name), the
image has no step rather than a guessed one. Only Claude, Droid and Codex
turns report running steps to Wisp; Cursor and OpenCode are read once the
turn ends, so their published images have no step. `step` is also absent on
images recorded before steps were kept.

## CLI and retention

The CLI prints file metadata, provenance and save commands; it does not
render terminal bitmap graphics:

```sh
wisp output list <task> --turn 1
wisp output save <task> <image-id> --turn 1 --out ./saved.png
```

Each listed image says whether it was `shared` or `looked at`, and in which
step: `before.png (48213 bytes, shared in: wisp output add before.png --turn 1)`.
`add` and `list` accept `--json`. `save` refuses to overwrite an existing file.
`wisp show` also lists each turn's output images the same way.

Images belong to the task, independently of the worktree. Current archives
retain them, task export includes them, and task storage accounts for their
bytes. Permanent deletion removes them with the rest of the task. A missing
image remains visible by name with an unavailable notice; old archives whose
assets were removed show a placeholder.
