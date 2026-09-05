import type { ImageDeliveryStrategy, ImageInputStrategy } from "./types";

export const IMAGE_INPUT_STRATEGIES: Record<string, ImageInputStrategy> = {
  /**
   * claude (spike-verified live, claude-code 2.1.240): with an image, the
   * prompt moves off argv into one stdin NDJSON line — a stream-json user
   * message whose content is the base64 image blocks followed by one text
   * block. `--input-format stream-json` only works with `-p` (already the
   * exec argv), and the output side is untouched (`--output-format
   * stream-json --verbose` stays). The runner writes the line and closes
   * stdin; one-shot semantics survive.
   */
  "claude-stream-json": {
    argv: ["--input-format", "stream-json"],
    envelope: (prompt, files) =>
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            ...files.map((f) => ({
              type: "image",
              source: { type: "base64", media_type: f.mediaType, data: f.dataBase64 },
            })),
            { type: "text", text: prompt },
          ],
        },
      }),
  },
};

export const IMAGE_DELIVERY_STRATEGIES: Record<string, ImageDeliveryStrategy> = {
  /**
   * droid (spike ts7efd, re-probed live on 2026-08-29, droid 0.193.0 +
   * claude-opus-5): `droid exec` has no image flag and no stdin image
   * envelope, but its Read tool decodes an image file into the model's
   * context. The probe rendered a word only present in pixels, told droid to
   * read the file, and got that word back verbatim.
   *
   * The path was ABSOLUTE and OUTSIDE the cwd, and Read took it anyway. That
   * is why wisp copies nothing: the stored file under
   * `~/.wisp/tasks/<id>/attachments/turn-<n>/` is named as-is. A copy into the
   * worktree would show up in the task's own diff, in the dirty check archive
   * refuses on, and in the commit D3's force-archive makes — an attachment
   * would silently become part of the work.
   *
   * png/jpeg only: Read throws a TypeError on gif and webp, so those are
   * refused at the boundary with a named reason instead of being handed over
   * to break mid-turn.
   *
   * What wisp cannot know: whether the selected model has vision. droid's
   * catalog carries the flag internally (`noImageSupport` in its bundle) but
   * exposes it on NO CLI surface — the only model list droid prints is a flat
   * list of ids in its invalid-model error. Hardcoding vision per model would
   * be a lie with a shelf life, so the guard is in the prompt instead: it asks
   * droid to say it cannot see the file rather than guess. That turns the one
   * failure mode path delivery has — silent success with a wrong answer — into
   * a sentence in the turn's output.
   *
   * cursor joined this strategy 2026-08-31 (slice 9 follow-up): cursor-agent
   * has no image flag and no stdin envelope either, but its readToolCall
   * decodes images — live-verified on 2026.08.25 with cursor-grok-4.6-high,
   * which recited an unbluffable seeded 4×3 color grid + border from a PNG it
   * was handed by path. The composer note is harness-generic because the
   * strategy now serves two harnesses.
   */
  "read-tool-path": {
    accepts: ["image/png", "image/jpeg"],
    preamble: (paths) => {
      const one = paths.length === 1;
      return [
        `${one ? "An image is" : `${paths.length} images are`} attached to this message as ${one ? "a file" : "files"} on disk.`,
        `Read ${one ? "it" : "them"} with your file-reading tool before answering:`,
        ...paths.map((p) => `  ${p}`),
        `If you cannot see ${one ? "the image" : "these images"}, say so plainly instead of guessing what ${one ? "it shows" : "they show"}.`,
      ].join("\n");
    },
    note: "this harness has no image flag: wisp names the file's path in the prompt and the harness reads it. png and jpeg only, and the prompt asks the model to say so if it cannot see the file.",
  },
};
