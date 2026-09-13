import {
  AttachmentUploadError,
  discardAttachmentUpload,
  stageAttachmentUpload,
} from "../attachment-uploads";
import {
  ATTACHMENT_KIND_LIMITS,
  attachmentKind,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_ATTACHMENTS,
} from "../attachments";
import { err, json } from "./http";

/** POST /api/attachments?name=<filename> — stage one raw, bounded file body. */
export async function attachmentUploadRoute(req: Request, url: URL): Promise<Response> {
  const name = url.searchParams.get("name");
  if (name === null) return err("attachment name is required", 400);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    return err(`attachment is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} per-file limit`, 413);
  }
  try {
    const staged = await stageAttachmentUpload(req, name, MAX_ATTACHMENT_BYTES);
    const kind = attachmentKind(staged.mediaType);
    const limit = ATTACHMENT_KIND_LIMITS[kind];
    if (staged.size > limit) {
      discardAttachmentUpload(staged.uploadId);
      return err(
        `${name}: ${formatBytes(staged.size)} exceeds the ${formatBytes(limit)} limit for ${kind} attachments`,
        413,
      );
    }
    return json({
      uploadId: staged.uploadId,
      name: staged.name,
      size: staged.size,
      mediaType: staged.mediaType,
      contentHash: staged.contentHash,
    }, 201);
  } catch (error) {
    if (error instanceof AttachmentUploadError) {
      const detail = error.message.includes("not a supported attachment")
        ? `${error.message} — wisp takes ${SUPPORTED_ATTACHMENTS}`
        : error.status === 413
          ? `attachment is over the ${formatBytes(MAX_ATTACHMENT_BYTES)} per-file limit`
          : error.message;
      return err(detail, error.status);
    }
    throw error;
  }
}

/** DELETE /api/attachments/:id — idempotently discard an unused upload. */
export function discardAttachmentUploadRoute(uploadId: string): Response {
  discardAttachmentUpload(uploadId);
  return json({ ok: true });
}
