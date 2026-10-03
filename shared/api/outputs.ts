/** Images explicitly published by an agent, or captured from a native tool result. */
export interface OutputImage {
  /** Content hash, scoped to the owning task and turn. Never a filesystem path. */
  id: string;
  name: string;
  size: number;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  source: "native" | "published";
}

export function outputImageUrl(taskId: string, turn: number, imageId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/outputs/${turn}/${encodeURIComponent(imageId)}`;
}
