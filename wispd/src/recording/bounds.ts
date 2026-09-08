export type BoundedJson = null | boolean | number | string | BoundedJson[] | { [key: string]: BoundedJson };

export interface RecordBounds {
  maxRecordBytes: number;
  maxStringBytes: number;
  maxTotalStringBytes: number;
  maxCollectionItems: number;
  maxDepth: number;
  maxNodes: number;
}

export const DEFAULT_RECORD_BOUNDS: Readonly<RecordBounds> = {
  maxRecordBytes: 64 * 1024,
  maxStringBytes: 16 * 1024,
  maxTotalStringBytes: 48 * 1024,
  maxCollectionItems: 64,
  maxDepth: 6,
  maxNodes: 512,
};

export interface BoundedRecord {
  value: BoundedJson;
  json: string;
  bytes: number;
  truncated: boolean;
  omittedBytes: number;
  omittedValues: number;
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/** UTF-8-safe prefix truncation with no full-size encoded copy. */
export function truncateUtf8(value: string, maxBytes: number): { value: string; omittedBytes: number } {
  const originalBytes = utf8Bytes(value);
  if (originalBytes <= maxBytes) return { value, omittedBytes: 0 };
  if (maxBytes <= 0) return { value: "", omittedBytes: originalBytes };

  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (utf8Bytes(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not retain half of a surrogate pair. Buffer would encode the unmatched
  // half as a replacement character, producing a misleading byte count.
  if (low > 0 && low < value.length) {
    const last = value.charCodeAt(low - 1);
    const next = value.charCodeAt(low);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) low--;
  }
  const kept = value.slice(0, low);
  return { value: kept, omittedBytes: originalBytes - utf8Bytes(kept) };
}

interface BoundState {
  remainingNodes: number;
  remainingStringBytes: number;
  omittedBytes: number;
  omittedValues: number;
  truncated: boolean;
  seen: WeakSet<object>;
}

function omission(state: BoundState, bytes = 0): string {
  state.truncated = true;
  state.omittedValues++;
  state.omittedBytes += bytes;
  return "[wisp: omitted]";
}

function boundedValue(value: unknown, bounds: RecordBounds, state: BoundState, depth: number): BoundedJson {
  if (state.remainingNodes <= 0) return omission(state);
  state.remainingNodes--;

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const limit = Math.max(0, Math.min(bounds.maxStringBytes, state.remainingStringBytes));
    const truncated = truncateUtf8(value, limit);
    state.remainingStringBytes -= utf8Bytes(truncated.value);
    if (truncated.omittedBytes > 0) {
      state.truncated = true;
      state.omittedBytes += truncated.omittedBytes;
      state.omittedValues++;
      return `${truncated.value}[wisp: ${truncated.omittedBytes} bytes omitted]`;
    }
    return truncated.value;
  }
  if (typeof value !== "object") return omission(state);
  if (depth >= bounds.maxDepth) return omission(state);
  if (state.seen.has(value)) return omission(state);
  state.seen.add(value);

  if (Array.isArray(value)) {
    const kept = value.slice(0, bounds.maxCollectionItems);
    if (kept.length < value.length) {
      state.truncated = true;
      state.omittedValues += value.length - kept.length;
    }
    const result = kept.map((item) => boundedValue(item, bounds, state, depth + 1));
    state.seen.delete(value);
    return result;
  }

  const result: Record<string, BoundedJson> = {};
  let keptEntries = 0;
  for (const rawKey in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
    if (keptEntries >= bounds.maxCollectionItems) {
      state.truncated = true;
      state.omittedValues++;
      break;
    }
    const key = truncateUtf8(rawKey, 256);
    if (key.omittedBytes > 0) {
      state.truncated = true;
      state.omittedBytes += key.omittedBytes;
      state.omittedValues++;
    }
    result[key.value] = boundedValue((value as Record<string, unknown>)[rawKey], bounds, state, depth + 1);
    keptEntries++;
  }
  state.seen.delete(value);
  return result;
}

function fitFallback(
  value: BoundedJson,
  bounds: RecordBounds,
  omittedBytes: number,
  omittedValues: number,
): { value: BoundedJson; json: string } {
  const recordType =
    value && !Array.isArray(value) && typeof value === "object" && typeof value.type === "string"
      ? truncateUtf8(value.type, 256).value
      : "unknown";
  const shell = {
    type: recordType,
    capture: { truncated: true, reason: "record-byte-limit", omittedBytes, omittedValues },
    preview: "",
  };
  const emptyBytes = utf8Bytes(JSON.stringify(shell));
  const source = JSON.stringify(value);
  shell.preview = truncateUtf8(source, Math.max(0, bounds.maxRecordBytes - emptyBytes - 16)).value;
  let json = JSON.stringify(shell);
  while (utf8Bytes(json) > bounds.maxRecordBytes && shell.preview.length > 0) {
    shell.preview = shell.preview.slice(0, Math.floor(shell.preview.length * 0.8));
    json = JSON.stringify(shell);
  }
  if (utf8Bytes(json) > bounds.maxRecordBytes) {
    const minimal: BoundedJson = { type: "capture.truncated" };
    const minimalJson = JSON.stringify(minimal);
    return utf8Bytes(minimalJson) <= bounds.maxRecordBytes
      ? { value: minimal, json: minimalJson }
      : { value: null, json: "null" };
  }
  return { value: shell, json };
}

/**
 * Structurally bound an unknown JSON event before it reaches JSON.stringify.
 * `originalBytes`, when already known from the wire frame, improves omission
 * accounting without serializing the untrusted original a second time.
 */
export function boundJsonRecord(
  input: unknown,
  options: Partial<RecordBounds> = {},
  originalBytes?: number,
): BoundedRecord {
  const bounds = { ...DEFAULT_RECORD_BOUNDS, ...options };
  if (!Number.isInteger(bounds.maxRecordBytes) || bounds.maxRecordBytes < 4) {
    throw new Error("maxRecordBytes must be an integer of at least 4");
  }
  const state: BoundState = {
    remainingNodes: bounds.maxNodes,
    remainingStringBytes: bounds.maxTotalStringBytes,
    omittedBytes: 0,
    omittedValues: 0,
    truncated: false,
    seen: new WeakSet(),
  };
  let value = boundedValue(input, bounds, state, 0);
  let json = JSON.stringify(value);
  if (utf8Bytes(json) > bounds.maxRecordBytes) {
    state.truncated = true;
    state.omittedValues++;
    const fitted = fitFallback(value, bounds, state.omittedBytes, state.omittedValues);
    value = fitted.value;
    json = fitted.json;
  }
  const bytes = utf8Bytes(json);
  const omittedBytes = originalBytes === undefined
    ? state.omittedBytes
    : Math.max(state.omittedBytes, Math.max(0, originalBytes - bytes));
  return {
    value,
    json,
    bytes,
    truncated: state.truncated,
    omittedBytes,
    omittedValues: state.omittedValues,
  };
}

export interface BudgetCategory {
  records: number;
  bytes: number;
}

export interface RecordBudgetSnapshot {
  lastSequence: number;
  retainedRecords: number;
  retainedBytes: number;
  omittedRecords: number;
  omittedBytes: number;
  firstOmittedSequence: number | null;
  lastOmittedSequence: number | null;
  omittedByCategory: Record<string, BudgetCategory>;
}

export interface RecordAdmission {
  sequence: number;
  bytes: number;
  retained: boolean;
}

/** A sequence authority and simultaneous UTF-8 byte/record admission budget. */
export class SequencedRecordBudget {
  private sequence = 0;
  private retainedRecords = 0;
  private retainedBytes = 0;
  private omittedRecords = 0;
  private omittedBytes = 0;
  private firstOmittedSequence: number | null = null;
  private lastOmittedSequence: number | null = null;
  private readonly omittedByCategory: Record<string, BudgetCategory> = {};

  constructor(
    readonly maxBytes: number,
    readonly maxRecords: number,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative integer");
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
      throw new Error("maxRecords must be a non-negative integer");
    }
  }

  offer(json: string, category = "event", allowRetention = true): RecordAdmission {
    const sequence = ++this.sequence;
    const bytes = utf8Bytes(json) + 1; // persisted JSONL includes the newline
    const retained =
      allowRetention && this.retainedRecords < this.maxRecords && this.retainedBytes + bytes <= this.maxBytes;
    if (retained) {
      this.retainedRecords++;
      this.retainedBytes += bytes;
    } else {
      this.omittedRecords++;
      this.omittedBytes += bytes;
      this.firstOmittedSequence ??= sequence;
      this.lastOmittedSequence = sequence;
      const bucket = (this.omittedByCategory[category] ??= { records: 0, bytes: 0 });
      bucket.records++;
      bucket.bytes += bytes;
    }
    return { sequence, bytes, retained };
  }

  snapshot(): RecordBudgetSnapshot {
    return {
      lastSequence: this.sequence,
      retainedRecords: this.retainedRecords,
      retainedBytes: this.retainedBytes,
      omittedRecords: this.omittedRecords,
      omittedBytes: this.omittedBytes,
      firstOmittedSequence: this.firstOmittedSequence,
      lastOmittedSequence: this.lastOmittedSequence,
      omittedByCategory: structuredClone(this.omittedByCategory),
    };
  }
}
