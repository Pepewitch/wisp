# Attachments

Attach files to a task's first turn (`wisp new`) or any follow-up
(`wisp send`) with `--attach <path>`. The flag repeats (`--image` is the old
name and still works, for the same thing):

```
wisp new ~/repo "what does this screen show?" --harness claude --attach ./a.png --attach ./b.jpg
wisp send tq2szu "the fix should match this mock" --attach ./mock.png
```

## Limits and validation

- Up to **10 files per turn**, **50 MB total**.
- Accepted types, sniffed from the file's magic bytes (never the filename or
  a pasted mime type), each with its own per-file cap:

  | kind | types | per-file cap |
  |---|---|---|
  | image | png, jpeg, gif, webp | 5 MB |
  | pdf | pdf | 20 MB |
  | text | utf-8 text | 20 MB |
  | video | mp4, mov, webm | 50 MB |

- The CLI fails early on a missing path or an unsupported file; the daemon
  re-validates everything (count, size, type) and rejects with a named 400.
  Nothing is ever dropped silently.

## How each harness receives the image

| harness | delivery | types |
|---|---|---|
| claude | native: base64 image blocks + the prompt on one stdin stream-json line | png, jpeg, gif, webp |
| codex | native: `-i <path>… --` on the argv | png, jpeg, gif, webp |
| droid | path in the prompt: the harness's file-reading tool decodes the file | png, jpeg only |
| cursor | same path-in-the-prompt strategy as droid | png, jpeg only |
| opencode | native: `-f <path>… --` on the argv | png, jpeg, gif, webp |

For droid/cursor, wisp prepends a preamble naming the absolute path(s) and
asking the model to say plainly if it cannot see the image — whether a model
has vision is not something those CLIs expose, so a model that can't see must
say so in the turn output instead of guessing. gif/webp are refused up front
for these two harnesses with a named reason.

pdf, text, and video attachments are not native to any adapter: every harness
receives them the same way droid/cursor receive images — a path in the prompt
that the harness's own file-reading tool reads.

## Lifecycle

- Attachments are stored under `~/.wisp/tasks/<id>/attachments/turn-<n>/` —
  deliberately OUTSIDE the worktree, so one never shows up in the task's diff,
  the archive dirty-check, or a commit.
- They belong to exactly the turn that carried them. Resume turns re-attach
  nothing; the harness keeps earlier attachments in its session context.
- Filenames are sanitized; a collision earns a `-2`/`-3` suffix, never an
  overwrite.

## Seeing what was attached

- `wisp show <id>` lists each turn's attachments with sizes.
- `wisp log <id>` contains a plain `· attached: red.png (320 KB)` line before
  the harness output of that turn.
- Bytes are served at `GET /api/tasks/<id>/attachments/<turn>/<name>` (bearer
  auth, content-type sniffed from the bytes).

## Archive

Archiving a task (plain or forced) keeps the attachment bytes — only the
worktree is removed. `wisp show` keeps naming what was attached, and
`GET /api/tasks/<id>/attachments/<turn>/<name>` keeps serving the bytes.
`wisp purge` is what actually deletes them, one task or, with
`--archived-before`, in bulk; the `410 Gone` some older archives still show is
a leftover from archives made before the daemon started retaining
attachments, not the current behavior. See
[Archive cleanup](../../../docs/ARCHIVE-CLEANUP.md).
