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

Wisp captures the images a harness showed its agent while the turn runs,
before transcript bounding, and names each after the file its tool call read
(`image.<ext>` when there was none):

| harness | what is captured |
|---|---|
| Claude | base64 image parts of a `tool_result`, e.g. from `Read`; the bytes are replaced in the transcript |
| Droid | base64 image parts of a `tool_result`, e.g. from `Read`; the bytes are replaced in the transcript |
| Codex | MCP image content; `image_view` files, copied from their path when the item completes; `image_generation` results, recorded as **shared** since the agent made them for you (the whole base64 `result`, captured before the transcript is bounded; the copy in Codex's own home is not read) |
| Cursor | nothing (known limit, below) |
| OpenCode | nothing (known limit, below) |

Cursor and OpenCode write their output straight to the log, so Wisp reads
their events only once the turn has ended. A file read from disk then cannot
show what the step saw (it may have been overwritten or replaced since), so
Wisp captures no images for them; images their agents share with
`wisp output add` or `wisp capture` still appear. Running them through live
input, as Claude, Droid and Codex are, would let Wisp capture their images
the way it does for those.

A Codex `image_view` reports only a path, so Wisp copies the file at that
moment. It resolves the path first (following symlinks) and copies only a
regular file, within the per-image limit, that is inside one of:

- the task's worktree;
- the task's own Wisp files (its attachments and outputs);
- the OS temp directory or `/tmp`, unless that place is also inside the Wisp
  home.

Anything else, including the rest of the Wisp home, is refused. A refusal,
an invalid image or a failed write adds an `Image output unavailable: <why>`
line to the activity while the agent continues. A captured image leaves an
`Image output: <name> (<bytes>; <id>)` line in its place in the log and the
raw transcript; the web hides that line where the image itself shows under
its step. Other native image event types are not inferred from arbitrary
tool JSON; publish those files with `wisp output add`. HTTP(S) Markdown
images retain their existing click-to-load behavior.

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
Wisp records a step only when it cannot be the wrong one:

- A captured image's step is the tool call whose result carried it.
- A published image's step is the turn's running command step when exactly
  one command step is running and its command is the publisher
  (`output add` for `wisp output add`, `wisp capture` for a capture). With
  no command running, or more than one (parallel calls), it has no step.
  Only Claude, Droid and Codex report running steps to Wisp, so Cursor and
  OpenCode published images have no step.
- Publishing bytes the agent already looked at turns that image into a
  shared one, under the publishing step when there is one, and otherwise
  under the step that first showed it.

`step` is also absent on images recorded before steps were kept.

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
