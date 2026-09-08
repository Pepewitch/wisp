import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  DIAGNOSTIC_DIR,
  diagnosticSettings,
  type WispConfig,
} from "../config";
import { setTurnDiagnosticCheckpoint, type TurnDiagnosticCheckpoint } from "../store";
import type { TurnDiagnosticState } from "../types";
import type { RecorderSource } from "./turn-recorder";

const SEGMENT_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_RECORD_INTERVAL = 64;
const CHECKPOINT_TIME_INTERVAL_MS = 1_000;
const SEGMENT_NAME = /^turn-(\d+)-(\d{6})\.jsonl$/;

interface Segment {
  index: number;
  path: string;
  size: number;
  mtimeMs: number;
}

interface TurnArchive {
  turnId: number;
  segments: Segment[];
}

export interface DiagnosticArchiveOptions {
  root: string;
  maxBytes: number;
  retentionMs: number;
  now?: () => number;
  checkpoint?: (turnId: number, checkpoint: TurnDiagnosticCheckpoint) => void;
}

export interface DiagnosticExportLease {
  paths: string[];
  release(): void;
}

/**
 * One process-local authority for the diagnostic directory. Every admission
 * is synchronous, so the aggregate size cannot race past the configured
 * ceiling. Eviction removes whole settled turns, never arbitrary middle
 * segments, and active writers/readers are protected.
 */
export class DiagnosticArchiveManager {
  private readonly groups = new Map<number, TurnArchive>();
  private readonly active = new Set<number>();
  private readonly leases = new Map<number, number>();
  private totalBytes = 0;
  private readonly now: () => number;
  private readonly checkpoint: (turnId: number, checkpoint: TurnDiagnosticCheckpoint) => void;

  constructor(readonly options: DiagnosticArchiveOptions) {
    this.now = options.now ?? Date.now;
    this.checkpoint = options.checkpoint ?? setTurnDiagnosticCheckpoint;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    chmodSync(options.root, 0o700);
    this.scan();
    this.maintain();
  }

  open(turnId: number): TurnDiagnosticWriter {
    this.active.add(turnId);
    this.maintain();
    return new TurnDiagnosticWriter(turnId, this);
  }

  acquire(turnId: number): DiagnosticExportLease {
    this.maintain();
    this.leases.set(turnId, (this.leases.get(turnId) ?? 0) + 1);
    let released = false;
    return {
      paths: [...(this.groups.get(turnId)?.segments ?? [])]
        .sort((a, b) => a.index - b.index)
        .map((segment) => segment.path),
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.leases.get(turnId) ?? 1) - 1;
        if (remaining > 0) this.leases.set(turnId, remaining);
        else this.leases.delete(turnId);
      },
    };
  }

  nextSegmentIndex(turnId: number): number {
    return Math.max(0, ...(this.groups.get(turnId)?.segments.map((segment) => segment.index) ?? [])) + 1;
  }

  ensureCapacity(bytes: number, protectedTurnId: number): boolean {
    if (bytes > this.options.maxBytes) return false;
    while (this.totalBytes + bytes > this.options.maxBytes) {
      const victim = this.oldestEvictable(protectedTurnId);
      if (victim === null) return false;
      if (!this.evict(victim, `global diagnostic quota (${this.options.maxBytes} bytes) required eviction`)) return false;
    }
    return true;
  }

  register(turnId: number, segment: Segment): void {
    let group = this.groups.get(turnId);
    if (!group) {
      group = { turnId, segments: [] };
      this.groups.set(turnId, group);
    }
    group.segments.push(segment);
  }

  addBytes(turnId: number, index: number, bytes: number): void {
    const segment = this.groups.get(turnId)?.segments.find((candidate) => candidate.index === index);
    if (!segment) return;
    segment.size += bytes;
    segment.mtimeMs = this.now();
    this.totalBytes += bytes;
  }

  settle(turnId: number): void {
    this.active.delete(turnId);
    this.maintain();
  }

  private scan(): void {
    for (const entry of readdirSync(this.options.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(SEGMENT_NAME);
      if (!match) continue;
      const path = join(this.options.root, entry.name);
      const stat = statSync(path);
      chmodSync(path, 0o600);
      const turnId = Number(match[1]);
      const segment = { index: Number(match[2]), path, size: stat.size, mtimeMs: stat.mtimeMs };
      this.register(turnId, segment);
      this.totalBytes += stat.size;
    }
  }

  private maintain(): void {
    const cutoff = this.now() - this.options.retentionMs;
    for (const group of [...this.groups.values()]) {
      if (this.protected(group.turnId)) continue;
      const newest = Math.max(0, ...group.segments.map((segment) => segment.mtimeMs));
      if (newest < cutoff) {
        this.evict(group.turnId, `diagnostic retention period expired`, new Date(this.now()).toISOString());
      }
    }
    while (this.totalBytes > this.options.maxBytes) {
      const victim = this.oldestEvictable();
      if (victim === null) break;
      if (!this.evict(victim, `global diagnostic quota (${this.options.maxBytes} bytes) required eviction`)) break;
    }
  }

  private protected(turnId: number): boolean {
    return this.active.has(turnId) || (this.leases.get(turnId) ?? 0) > 0;
  }

  private oldestEvictable(exceptTurnId?: number): number | null {
    let found: { turnId: number; touched: number } | null = null;
    for (const group of this.groups.values()) {
      if (group.turnId === exceptTurnId || this.protected(group.turnId)) continue;
      const touched = Math.max(0, ...group.segments.map((segment) => segment.mtimeMs));
      if (!found || touched < found.touched || (touched === found.touched && group.turnId < found.turnId)) {
        found = { turnId: group.turnId, touched };
      }
    }
    return found?.turnId ?? null;
  }

  private evict(turnId: number, detail: string, evictedAt = new Date(this.now()).toISOString()): boolean {
    const group = this.groups.get(turnId);
    if (!group) return true;
    let removed = 0;
    for (const segment of group.segments) {
      try {
        unlinkSync(segment.path);
        removed += segment.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[wisp] diagnostic eviction failed for turn ${turnId}: ${String(error)}`);
        } else {
          removed += segment.size;
        }
      }
    }
    const survivors = group.segments.filter((segment) => existsSync(segment.path));
    this.totalBytes -= removed;
    if (survivors.length > 0) {
      group.segments = survivors;
      this.safeCheckpoint(turnId, {
        state: "evicted",
        bytes: survivors.reduce((total, segment) => total + segment.size, 0),
        firstSeq: null,
        lastSeq: null,
        detail: `${detail}; some files could not be removed`,
        evictedAt,
      });
      return false;
    }
    this.groups.delete(turnId);
    this.safeCheckpoint(turnId, {
      state: "evicted",
      bytes: 0,
      firstSeq: null,
      lastSeq: null,
      detail,
      evictedAt,
    });
    return true;
  }

  safeCheckpoint(turnId: number, checkpoint: TurnDiagnosticCheckpoint): void {
    try {
      this.checkpoint(turnId, checkpoint);
    } catch (error) {
      console.error(`[wisp] turn ${turnId}: diagnostic checkpoint failed: ${String(error)}`);
    }
  }
}

export class TurnDiagnosticWriter {
  private state: TurnDiagnosticState = "partial";
  private detail: string | null = "diagnostic recording in progress";
  private bytes = 0;
  private firstSeq: number | null = null;
  private lastSeq: number | null = null;
  private segmentIndex = 0;
  private segmentBytes = 0;
  private fd: number | null = null;
  private dirtyRecords = 0;
  private lastCheckpointAt = Date.now();
  private stopped = false;
  private finished = false;

  constructor(readonly turnId: number, private readonly archive: DiagnosticArchiveManager) {
    this.segmentIndex = archive.nextSegmentIndex(turnId);
    this.checkpoint(true);
  }

  record(sequence: number, source: RecorderSource, line: string): void {
    if (this.stopped || this.finished) return;
    const encoded = Buffer.from(JSON.stringify({ version: 1, sequence, recordedAt: new Date().toISOString(), source, line }) + "\n");
    if (!this.archive.ensureCapacity(encoded.length, this.turnId)) {
      this.stop("diagnostic recording reached the global quota while active; the turn continued");
      return;
    }
    if (this.segmentBytes > 0 && this.segmentBytes + encoded.length > SEGMENT_BYTES) {
      this.rotate();
      if (this.stopped) return;
    }
    try {
      this.ensureOpen();
      let offset = 0;
      while (offset < encoded.length) {
        const written = writeSync(this.fd!, encoded, offset);
        if (written <= 0) throw new Error("diagnostic write made no progress");
        offset += written;
        this.archive.addBytes(this.turnId, this.segmentIndex, written);
        this.segmentBytes += written;
        this.bytes += written;
      }
      this.firstSeq ??= sequence;
      this.lastSeq = sequence;
      this.dirtyRecords++;
      this.checkpoint(false);
    } catch (error) {
      this.stop(`diagnostic recording failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.stopped) {
      this.state = "complete";
      this.detail = null;
    }
    this.closeFile();
    this.checkpoint(true);
    this.archive.settle(this.turnId);
  }

  private ensureOpen(): void {
    if (this.fd !== null) return;
    const path = join(this.archive.options.root, `turn-${this.turnId}-${String(this.segmentIndex).padStart(6, "0")}.jsonl`);
    this.fd = openSync(path, "wx", 0o600);
    chmodSync(path, 0o600);
    this.archive.register(this.turnId, {
      index: this.segmentIndex,
      path,
      size: 0,
      mtimeMs: Date.now(),
    });
  }

  private rotate(): void {
    this.closeFile();
    this.segmentIndex++;
    this.segmentBytes = 0;
  }

  private closeFile(): void {
    if (this.fd === null) return;
    try {
      fsyncSync(this.fd);
    } catch (error) {
      this.state = "partial";
      this.detail = `diagnostic sync failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      this.stopped = true;
    }
    try {
      closeSync(this.fd);
    } catch (error) {
      this.state = "partial";
      this.detail = `diagnostic close failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
      this.stopped = true;
    }
    this.fd = null;
  }

  private stop(detail: string): void {
    this.state = "partial";
    this.detail = detail.slice(0, 300);
    this.stopped = true;
    this.closeFile();
    this.checkpoint(true);
    console.error(`[wisp] turn ${this.turnId}: ${this.detail}`);
  }

  private checkpoint(force: boolean): void {
    const now = Date.now();
    if (!force && this.dirtyRecords < CHECKPOINT_RECORD_INTERVAL && now - this.lastCheckpointAt < CHECKPOINT_TIME_INTERVAL_MS) {
      return;
    }
    this.archive.safeCheckpoint(this.turnId, {
      state: this.state,
      bytes: this.bytes,
      firstSeq: this.firstSeq,
      lastSeq: this.lastSeq,
      detail: this.detail,
      evictedAt: null,
    });
    this.dirtyRecords = 0;
    this.lastCheckpointAt = now;
  }
}

const managers = new Map<string, DiagnosticArchiveManager>();

function managerFor(cfg: WispConfig): DiagnosticArchiveManager {
  const settings = diagnosticSettings(cfg);
  const key = `${DIAGNOSTIC_DIR}\0${settings.maxBytes}\0${settings.retentionMs}`;
  let manager = managers.get(key);
  if (!manager) {
    manager = new DiagnosticArchiveManager({
      root: DIAGNOSTIC_DIR,
      maxBytes: settings.maxBytes,
      retentionMs: settings.retentionMs,
    });
    managers.set(key, manager);
  }
  return manager;
}

export function createTurnDiagnosticWriter(turnId: number, cfg: WispConfig): TurnDiagnosticWriter | null {
  if (!diagnosticSettings(cfg).enabled) {
    try {
      // Disabling new capture does not strand older archives beyond their
      // configured TTL/quota; constructing the manager performs maintenance.
      managerFor(cfg);
    } catch {
      // The explicit disabled state remains authoritative even if cleanup is unavailable.
    }
    try {
      setTurnDiagnosticCheckpoint(turnId, {
        state: "disabled",
        bytes: 0,
        firstSeq: null,
        lastSeq: null,
        detail: "diagnostic recording is disabled by configuration",
        evictedAt: null,
      });
    } catch (error) {
      console.error(`[wisp] turn ${turnId}: diagnostic checkpoint failed: ${String(error)}`);
    }
    return null;
  }
  try {
    return managerFor(cfg).open(turnId);
  } catch (error) {
    const detail = `diagnostic recording unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
    try {
      setTurnDiagnosticCheckpoint(turnId, {
        state: "unavailable",
        bytes: 0,
        firstSeq: null,
        lastSeq: null,
        detail,
        evictedAt: null,
      });
    } catch {
      // The diagnostic path must not become a second failure path for a turn.
    }
    console.error(`[wisp] turn ${turnId}: ${detail}`);
    return null;
  }
}

export function acquireDiagnosticExport(cfg: WispConfig, turnId: number): DiagnosticExportLease {
  return managerFor(cfg).acquire(turnId);
}

/** Apply TTL/quota at daemon boot without making diagnostic storage a boot dependency. */
export function maintainDiagnosticArchives(cfg: WispConfig): void {
  try {
    managerFor(cfg);
  } catch (error) {
    console.error(`[wisp] diagnostic archive maintenance unavailable: ${String(error)}`);
  }
}
