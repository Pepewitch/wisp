# Image attachments

Attach images to a task's first turn (`wisp new`) or any follow-up
(`wisp send`) with `--image <path>`. The flag repeats:

```
wisp new ~/repo "what does this screen show?" --harness claude --image ./a.png --image ./b.jpg
wisp send tq2szu "the fix should match this mock" --image ./mock.png
```

## Limits and validation

- Up to **10 images per turn**, **5 MB each**.
- Accepted types: **png, jpeg, gif, webp** — decided by sniffing the file's
  magic bytes, never the filename or a pasted mime type.
- The CLI fails early on a missing path or a non-image file; the daemon
  re-validates everything (count, size, type) and rejects with a named 400.
  Nothing is ever dropped silently.

## How each harness receives the image

| harness | delivery | types |
|---|---|---|
| claude | native: base64 image blocks + the prompt on one stdin stream-json line | png, jpeg, gif, webp |
| codex | native: `-i <path>… --` on the argv | png, jpeg, gif, webp |
| droid | path in the prompt: the harness's file-reading tool decodes the file | png, jpeg only |
| cursor | same path-in-the-prompt strategy as droid | png, jpeg only |

For droid/cursor, wisp prepends a preamble naming the absolute path(s) and
asking the model to say plainly if it cannot see the image — whether a model
has vision is not something those CLIs expose, so a model that can't see must
say so in the turn output instead of guessing. gif/webp are refused up front
for these two harnesses with a named reason.

## Lifecycle

- Images are stored under `~/.wisp/tasks/<id>/attachments/turn-<n>/` —
  deliberately OUTSIDE the worktree, so an attachment never shows up in the
  task's diff, the archive dirty-check, or a commit.
- They belong to exactly the turn that carried them. Resume turns re-attach
  nothing; the harness keeps earlier images in its session context.
- Filenames are sanitized; a collision earns a `-2`/`-3` suffix, never an
  overwrite.

## Seeing what was attached

- `wisp show <id>` lists each turn's attachments with sizes.
- `wisp log <id>` contains a plain `· attached: red.png (320 KB)` line before
  the harness output of that turn.
- Bytes are served at `GET /api/tasks/<id>/attachments/<turn>/<name>` (bearer
  auth, content-type sniffed from the bytes).

## Archive

Archiving a task (plain or forced) deletes the image bytes. The manifest stays
on the turn rows, so `wisp show` still names what was attached (marked
"removed when this task was archived") and the bytes route answers `410 Gone`
rather than a misleading 404.
