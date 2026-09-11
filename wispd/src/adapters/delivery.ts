import { formatBytes } from "../text";

/**
 * Delivery by PATH: the sentences that put a stored attachment's absolute path
 * in front of the harness, for every file wisp cannot hand over through a
 * native channel (A1c for images on droid/cursor; A1d for pdf, text and video
 * on every harness).
 *
 * This is load-bearing rather than cosmetic. A file nobody reads is a turn that
 * succeeds with a wrong answer, so the instruction lives here, in the adapter
 * layer, and never depends on the user thinking to type it.
 */

/** The half of a StoredAttachment this module needs; kept local to avoid a cycle. */
export interface DeliveredFile {
  path: string;
  size: number;
  mediaType: string;
}

function isImage(file: DeliveredFile): boolean {
  return file.mediaType.startsWith("image/");
}

/**
 * The all-images wording, unchanged from the image-only slice: it was probed
 * live against droid and cursor, and a harness that reads files well from one
 * phrasing is not worth re-probing against another.
 */
function imagePreamble(files: DeliveredFile[]): string {
  const one = files.length === 1;
  return [
    `${one ? "An image is" : `${files.length} images are`} attached to this message as ${one ? "a file" : "files"} on disk.`,
    `Read ${one ? "it" : "them"} with your file-reading tool before answering:`,
    ...files.map((f) => `  ${f.path}`),
    `If you cannot see ${one ? "the image" : "these images"}, say so plainly instead of guessing what ${one ? "it shows" : "they show"}.`,
  ].join("\n");
}

/**
 * The mixed/document wording. Every line names the type and the size, because
 * the harness's next decision is which tool to open the file WITH — grep a
 * 40 MB csv, page a pdf, probe a video — and it cannot make that call from a
 * bare path.
 *
 * The video sentence is the honest one. No harness can watch a video and no
 * model behind these CLIs ingests one, so what an attached video actually buys
 * is a file on disk to sample frames from. Saying that is the difference
 * between a useful turn and a confident hallucination about footage.
 */
export function attachmentPreamble(files: DeliveredFile[]): string {
  if (files.length === 0) return "";
  if (files.every(isImage)) return imagePreamble(files);
  const one = files.length === 1;
  const hasVideo = files.some((f) => f.mediaType.startsWith("video/"));
  return [
    `${one ? "A file is" : `${files.length} files are`} attached to this message on disk.`,
    `Read ${one ? "it" : "them"} with your file tools before answering:`,
    ...files.map((f) => `  ${f.path} (${f.mediaType}, ${formatBytes(f.size)})`),
    ...(hasVideo
      ? [
          "You cannot watch a video directly: sample frames or read its metadata with ffmpeg/ffprobe if you need what is in it, and say so if neither is available.",
        ]
      : []),
    `If you cannot read ${one ? "it" : "one of these files"}, say so plainly instead of guessing what it contains.`,
  ].join("\n");
}
