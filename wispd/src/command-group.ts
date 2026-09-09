import { processSnapshot, sameProcess, type ProcessMember } from "./process-snapshot";

/** Short-lived command ownership; no task rows, recovery, or watcher policy. */
export class CommandGroup {
  private members: ProcessMember[] = [];
  private retired = false;
  private closed = false;
  private capturedExit = false;
  private exitRequested = false;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly child: ReturnType<typeof Bun.spawn>) {}

  close(): void { this.closed = true; }

  /** Capture survivors at the actual child-exit boundary, never from an old PID. */
  captureExit(): Promise<boolean> { this.exitRequested = true; return this.inspect(); }

  inspect(signal?: "SIGTERM" | "SIGKILL"): Promise<boolean> {
    const operation = this.pending.then(async () => {
      if (this.closed || this.retired) return true;
      let members = await processSnapshot(new Set([this.child.pid]));
      // A hard deadline may have finished this run while ps was answering.
      if (this.closed) return false;
      if (!members.length) { this.retired = true; return true; }
      const live = this.child.exitCode === null && this.child.signalCode === null;
      if (!live && members.some(member => member.pid === this.child.pid)) {
        // ps may have observed our leader just before Bun delivered its exit.
        // Recheck after the confirmed exit before calling that a reused PID.
        members = await processSnapshot(new Set([this.child.pid]));
        if (this.closed) return false;
        if (!members.length) { this.retired = true; return true; }
      }
      const leader = members.find(member => member.pid === this.child.pid);
      const exitCapture = this.exitRequested && !this.capturedExit;
      if (exitCapture) this.capturedExit = true;
      // A reaped child cannot be a living leader again: its PID was reused.
      if ((!live && leader) || (!live && !exitCapture &&
        !this.members.some(old => members.some(member => sameProcess(old, member))))) {
        throw new Error("command process-group ownership could not be verified");
      }
      this.members = members;
      if (signal) {
        if (!Number.isInteger(this.child.pid) || this.child.pid <= 1) throw new Error("invalid command process group");
        // No yield between identity validation and signalling the owned group.
        try { process.kill(-this.child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      return false;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
