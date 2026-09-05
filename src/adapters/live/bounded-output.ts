import { elideMiddle } from "../../text";
import { isRecord } from "../../validate";

/**
 * A live harness inlines a tool's entire output in the notification that
 * completes it, so one command over a large tree carries megabytes into the
 * turn log and, from there, into the activity stream. Bounding it at the
 * driver — before anything durable is written — keeps a single command from
 * spending the per-turn log budget, and leaves far more than a reader needs.
 */
export const MAX_INLINE_OUTPUT_CHARS = 32_000;

/**
 * Bound an inlined tool output. A harness sends either a plain string or
 * Anthropic-shaped content blocks; any other shape is passed through rather
 * than reshaped into something its consumers no longer recognize.
 *
 * Both ends of the text survive — a command's error or exit banner is usually
 * the last thing it printed — and the middle is named, not silently cut.
 */
export function boundedOutput(value: unknown, max = MAX_INLINE_OUTPUT_CHARS): unknown {
  if (typeof value === "string") return elideMiddle(value, max);
  if (Array.isArray(value)) return boundedBlocks(value, max);
  return value;
}

/** One budget across the whole block list, so 64 small blocks cannot add up to a large one. */
function boundedBlocks(blocks: unknown[], max: number): unknown[] {
  const bounded: unknown[] = [];
  let left = max;
  for (const block of blocks) {
    if (left <= 0) {
      bounded.push(`… ${blocks.length - bounded.length} more content blocks elided …`);
      break;
    }
    const [next, spent] = boundedBlock(block, left);
    bounded.push(next);
    left -= spent;
  }
  return bounded;
}

function boundedBlock(block: unknown, left: number): [unknown, number] {
  if (typeof block === "string") return [elideMiddle(block, left), Math.min(block.length, left)];
  if (!isRecord(block)) return [block, 0];
  for (const field of ["text", "content"]) {
    const value = block[field];
    if (typeof value === "string") {
      return [{ ...block, [field]: elideMiddle(value, left) }, Math.min(value.length, left)];
    }
  }
  return [block, 0];
}
