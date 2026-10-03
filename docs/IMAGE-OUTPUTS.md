# Image outputs

Agent output images appear below the turn's reply in Browser and Desktop.
Click an image to expand it; Download saves the original bytes, using a
native Save panel in Desktop and a browser download in Browser. Images use
the active daemon connection's authenticated asset transport. They remain
available when activity is collapsed or its transcript has been evicted.

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

Codex MCP image content and Claude base64 image content inside tool results
are captured automatically before transcript bounding. Adjacent text stays
in the tool result. Invalid images or failed storage writes produce an
explicit activity notice while the agent continues.

For Droid, Cursor, OpenCode, other native image event types, and tools that
return a file path instead of image bytes, use `wisp output add`. These
payloads are not inferred from arbitrary tool JSON. HTTP(S) Markdown images
retain their existing click-to-load behavior.

Native capture remains subject to the harness protocol's 16 MiB frame limit.
For a tool result containing several large images, publish the individual
files instead.

## CLI and retention

The CLI prints file metadata and save commands; it does not render terminal
bitmap graphics:

```sh
wisp output list <task> --turn 1
wisp output save <task> <image-id> --turn 1 --out ./saved.png
```

`add` and `list` accept `--json`. `save` refuses to overwrite an existing file.
`wisp show` also lists each turn's output images.

Images belong to the task, independently of the worktree. Current archives
retain them, task export includes them, and task storage accounts for their
bytes. Permanent deletion removes them with the rest of the task. A missing
image remains visible by name with an unavailable notice; old archives whose
assets were removed show a placeholder.
