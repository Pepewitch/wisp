/**
 * The activity step an image came from: its `id` is the tool call id the
 * turn's activity timeline gives that step, so a client can place the image
 * under it; `label` names the step for a reader who cannot see the timeline.
 */
export interface OutputStep {
  id: string;
  label: string;
}

/** Images explicitly published by an agent, or captured from a native tool result. */
export interface OutputImage {
  /** Content hash, scoped to the owning task and turn. Never a filesystem path. */
  id: string;
  name: string;
  size: number;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** `native`: a tool the agent ran showed it the image. `published`: the agent shared it. */
  source: "native" | "published";
  /** Absent on images recorded before steps were kept, or when no step was running. */
  step?: OutputStep;
}

export function outputImageUrl(taskId: string, turn: number, imageId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/outputs/${turn}/${encodeURIComponent(imageId)}`;
}
