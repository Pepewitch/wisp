export interface BrokerRecord {
  sequence: number;
  source: "stdout" | "stderr";
  line: string;
}

export interface BrokerGap {
  kind: "gap";
  firstSequence: number;
  lastSequence: number;
  records: number;
  bytes: number;
}

export type BrokerDelivery = { kind: "record"; record: BrokerRecord } | BrokerGap;

const DEFAULT_SUBSCRIBER_RECORDS = 512;
const DEFAULT_SUBSCRIBER_BYTES = 1_048_576;

class BrokerSubscriber {
  private readonly queue: BrokerRecord[] = [];
  private queueBytes = 0;
  private gap: BrokerGap | null = null;
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly maxRecords: number,
    private readonly maxBytes: number,
  ) {}

  offer(record: BrokerRecord): void {
    if (this.closed) return;
    const bytes = Buffer.byteLength(record.line, "utf8") + 1;
    while (this.queue.length > 0 && (this.queue.length >= this.maxRecords || this.queueBytes + bytes > this.maxBytes)) {
      const dropped = this.queue.shift()!;
      const droppedBytes = Buffer.byteLength(dropped.line, "utf8") + 1;
      this.queueBytes -= droppedBytes;
      this.addGap(dropped.sequence, droppedBytes);
    }
    if (bytes > this.maxBytes || this.maxRecords === 0) this.addGap(record.sequence, bytes);
    else {
      this.queue.push(record);
      this.queueBytes += bytes;
    }
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  async next(): Promise<BrokerDelivery | null> {
    for (;;) {
      if (this.gap) {
        const gap = this.gap;
        this.gap = null;
        return gap;
      }
      const record = this.queue.shift();
      if (record) {
        this.queueBytes -= Buffer.byteLength(record.line, "utf8") + 1;
        return { kind: "record", record };
      }
      if (this.closed) return null;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private addGap(sequence: number, bytes: number): void {
    if (!this.gap) {
      this.gap = { kind: "gap", firstSequence: sequence, lastSequence: sequence, records: 1, bytes };
      return;
    }
    this.gap.firstSequence = Math.min(this.gap.firstSequence, sequence);
    this.gap.lastSequence = Math.max(this.gap.lastSequence, sequence);
    this.gap.records++;
    this.gap.bytes += bytes;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

export interface TurnBrokerSubscription {
  highWaterSequence: number;
  primaryOffset: number;
  next(): Promise<BrokerDelivery | null>;
  close(): void;
}

/** One bounded fan-out channel for a recorder-owned running turn. */
export class TurnBroker {
  private readonly subscribers = new Set<BrokerSubscriber>();
  private highWaterSequence = 0;
  private primaryOffset = 0;
  private closed = false;

  publish(record: BrokerRecord): void {
    if (this.closed) return;
    this.highWaterSequence = Math.max(this.highWaterSequence, record.sequence);
    for (const subscriber of this.subscribers) subscriber.offer(record);
  }

  setPrimaryOffset(offset: number): void {
    this.primaryOffset = offset;
  }

  subscribe(
    maxRecords = DEFAULT_SUBSCRIBER_RECORDS,
    maxBytes = DEFAULT_SUBSCRIBER_BYTES,
  ): TurnBrokerSubscription {
    const subscriber = new BrokerSubscriber(maxRecords, maxBytes);
    if (this.closed) subscriber.close();
    else this.subscribers.add(subscriber);
    let released = false;
    return {
      // Both values are captured after the subscriber is registered. Any
      // later publication is therefore queued, never lost in a snapshot race.
      highWaterSequence: this.highWaterSequence,
      primaryOffset: this.primaryOffset,
      next: () => subscriber.next(),
      close: () => {
        if (released) return;
        released = true;
        this.subscribers.delete(subscriber);
        subscriber.close();
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscriber of this.subscribers) subscriber.close();
    this.subscribers.clear();
  }
}

const brokers = new Map<number, TurnBroker>();

export function openTurnBroker(turnId: number): TurnBroker {
  const broker = new TurnBroker();
  brokers.get(turnId)?.close();
  brokers.set(turnId, broker);
  return broker;
}

export function subscribeTurnBroker(turnId: number): TurnBrokerSubscription | null {
  return brokers.get(turnId)?.subscribe() ?? null;
}

export function closeTurnBroker(turnId: number): void {
  const broker = brokers.get(turnId);
  if (!broker) return;
  brokers.delete(turnId);
  broker.close();
}
