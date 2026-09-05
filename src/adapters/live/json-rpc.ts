export interface WritableRpcSink {
  write(data: string): unknown;
  flush(): unknown;
  end(): unknown;
}

export interface RpcFrame {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcPeerOptions {
  sink: WritableRpcSink;
  label: string;
  timeoutMs?: number;
  requestFrame?: (
    id: string,
    method: string,
    params: Record<string, unknown>,
  ) => Record<string, unknown>;
  errorMessage: (error: unknown) => string;
}

const DEFAULT_CALL_TIMEOUT_MS = 15_000;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function within<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Serialized JSON-RPC writes with bounded calls and close-safe rejection. */
export class JsonRpcPeer {
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 0;
  private writeChain = Promise.resolve();
  private closed = false;

  constructor(private readonly options: JsonRpcPeerOptions) {}

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.options.label} input is closed`));
    const id = String(++this.nextId);
    const frame = this.options.requestFrame?.(id, method, params) ?? {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.reject(id, new Error(`${this.options.label} request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write(frame).catch((error) => this.reject(id, asError(error)));
    });
  }

  notify(method: string, params?: Record<string, unknown>): Promise<void> {
    return this.write({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
  }

  handle(frame: RpcFrame): boolean {
    if (frame.id === undefined || frame.id === null) return false;
    const id = String(frame.id);
    const call = this.pending.get(id);
    if (!call) return true;
    this.pending.delete(id);
    clearTimeout(call.timer);
    if (frame.error !== undefined && frame.error !== null) {
      call.reject(
        new Error(`${this.options.label} rejected the request: ${this.options.errorMessage(frame.error)}`),
      );
    } else {
      call.resolve(frame.result);
    }
    return true;
  }

  failPending(message: string): void {
    for (const id of this.pending.keys()) this.reject(id, new Error(message));
  }

  close(): Promise<void> {
    if (this.closed) return this.writeChain.catch(() => {});
    this.closed = true;
    this.failPending(`${this.options.label} input is closed`);
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        const timeoutMs = this.options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
        await within(
          Promise.resolve(this.options.sink.end()),
          timeoutMs,
          `${this.options.label} close timed out after ${timeoutMs}ms`,
        );
      });
    return this.writeChain;
  }

  private write(frame: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error(`${this.options.label} input is closed`));
    this.writeChain = this.writeChain.then(async () => {
      if (this.closed) throw new Error(`${this.options.label} input is closed`);
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      await within(
        Promise.resolve(this.options.sink.write(`${JSON.stringify(frame)}\n`)),
        timeoutMs,
        `${this.options.label} write timed out after ${timeoutMs}ms`,
      );
      await within(
        Promise.resolve(this.options.sink.flush()),
        timeoutMs,
        `${this.options.label} flush timed out after ${timeoutMs}ms`,
      );
    });
    return this.writeChain;
  }

  private reject(id: string, error: Error): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    call.reject(error);
  }
}
