import { PROCESS_BOOT_ID } from "./process-boot";
import { emit } from "./events";
import { db, getTask, getTurn } from "./store";
import { processSnapshot, sameProcess, type GroupMember, type ProcessMember } from "./process-snapshot";

export interface BackgroundWork {
  state: "none" | "running" | "unknown" | "stopping";
  groups: number;
}
interface GroupRow {
  turn_id: number; task_id: string; pgid: number; boot_id: string | null; members_json: string;
  state: "none" | "running" | "unknown"; stop_requested: number;
}
const localGroups = new Set<number>();
const stops = new Map<string, Promise<void>>();
let refreshing: Promise<void> = Promise.resolve();
const TURN_LAUNCH_CLOCK_SLOP_MS = 10_000;

function rows(taskId?: string): GroupRow[] {
  return db.query(`SELECT * FROM turn_process_groups WHERE state != 'none'${taskId ? " AND task_id = ?" : ""}`)
    .all(...(taskId ? [taskId] : [])) as GroupRow[];
}
function notify(taskId: string): void {
  const task = getTask(taskId);
  if (task) emit({ type: "task", taskId, state: task.state, stateDetail: task.state_detail, seq: task.seq });
}

/**
 * A pre-registry migration row has no boot identity. If its old numeric group
 * id now has a new leader, preserve that process unless chronology proves the
 * old group ended first. lstart is rendered in the daemon's current timezone,
 * so compare its parsed instant with the ISO turn timestamps instead of the
 * old timezone-sensitive identity token.
 */
function groupLeaderReplacedAfterTurn(leader: GroupMember, turn: NonNullable<ReturnType<typeof getTurn>>): boolean {
  if (leader.observedStartedAt === null || turn.ended_at === null) return false;
  const launchedAt = Date.parse(turn.started_at);
  const endedAt = Date.parse(turn.ended_at);
  if (!Number.isFinite(launchedAt) || !Number.isFinite(endedAt)) return false;
  // If the host clock moved backwards during the turn, its original process
  // can appear newer than ended_at. It will still be near the durable launch.
  if (Math.abs(leader.observedStartedAt - launchedAt) <= TURN_LAUNCH_CLOCK_SLOP_MS) return false;
  return leader.observedStartedAt > endedAt;
}

function historicalGroupIdentity(
  row: Pick<GroupRow, "boot_id" | "pgid">,
  leader: GroupMember | undefined,
  turn: ReturnType<typeof getTurn>,
): { reused: boolean; ended: boolean } {
  const reused = Boolean(
    leader?.started && turn?.pid_start_time && !sameProcess(leader, { pid: row.pgid, started: turn.pid_start_time }),
  );
  return {
    reused,
    ended: Boolean(row.boot_id === null && reused && leader && turn && groupLeaderReplacedAfterTurn(leader, turn)),
  };
}

/** Written next to turn creation, before the event loop can observe the spawn. */
export function recordProcessGroup(turnId: number): void {
  const turn = getTurn(turnId);
  if (!turn?.pid) return;
  db.query(`INSERT INTO turn_process_groups (turn_id, task_id, pgid, boot_id, members_json, state) VALUES (?, ?, ?, ?, ?, 'running')`)
    .run(turnId, turn.task_id, turn.pid, PROCESS_BOOT_ID, JSON.stringify([{ pid: turn.pid, started: turn.pid_start_time }]));
  localGroups.add(turnId);
}

/** Agent outcome stays on the task; background work is a separate resource fact. */
export function backgroundWork(taskId: string): BackgroundWork {
  const all = rows(taskId);
  const background = all.filter(row => getTurn(row.turn_id)?.status !== "running");
  if (stops.has(taskId)) return { state: "stopping", groups: all.length };
  if (background.some(row => row.state === "unknown" || row.stop_requested)) return { state: "unknown", groups: background.length };
  return { state: background.length ? "running" : "none", groups: background.length };
}

export function hasRecordedGroup(turnId: number): boolean {
  return Boolean(db.query("SELECT 1 FROM turn_process_groups WHERE turn_id = ?").get(turnId));
}

export function recordedGroupRebooted(turnId: number): boolean {
  const row = db.query("SELECT boot_id FROM turn_process_groups WHERE turn_id = ?").get(turnId) as { boot_id: string | null } | null;
  return row?.boot_id != null && PROCESS_BOOT_ID !== null && row.boot_id !== PROCESS_BOOT_ID;
}

export function processStopPending(taskId: string): boolean {
  return stops.has(taskId) || rows(taskId).some(row => row.stop_requested !== 0);
}
export function processStop(taskId: string): Promise<void> | undefined { return stops.get(taskId); }

/** Serialize inventories so a slow poll cannot overwrite a newer Stop result. */
export function refreshProcessGroups(taskId?: string, exitedTurnId?: number): Promise<void> {
  const run = refreshing.then(async () => {
    const pending = rows(taskId);
    if (!pending.length) return;
    let inventory: Awaited<ReturnType<typeof processSnapshot>>;
    try { inventory = await processSnapshot(new Set(pending.map(row => row.pgid))); }
    catch {
      const changedTasks = new Set<string>();
      for (const row of pending) {
        if (row.state === "unknown") continue;
        db.query("UPDATE turn_process_groups SET state = 'unknown' WHERE turn_id = ?").run(row.turn_id);
        changedTasks.add(row.task_id);
      }
      for (const changedTask of changedTasks) notify(changedTask);
      return;
    }
    for (const row of pending) {
      const members = inventory.filter(member => member.pgid === row.pgid);
      let known: ProcessMember[];
      try {
        const parsed: unknown = JSON.parse(row.members_json);
        known = Array.isArray(parsed) ? parsed.filter((value): value is ProcessMember =>
          value !== null && typeof value === "object" && Number.isInteger(value.pid) &&
          (typeof value.started === "string" || value.started === null)) : [];
      } catch { known = []; }
      const original = getTurn(row.turn_id);
      const leader = members.find(member => member.pid === row.pgid);
      // Never adopt a group whose leader has a different identity. Even an
      // apparent start-time mismatch can be a locale/timezone change in old ps
      // timestamps, so preserve files instead of assuming the old work ended.
      const identity = historicalGroupIdentity(row, leader, original);
      let state: GroupRow["state"];
      const sameBoot = row.boot_id !== null && PROCESS_BOOT_ID !== null && row.boot_id === PROCESS_BOOT_ID;
      const rebooted = row.boot_id !== null && PROCESS_BOOT_ID !== null && row.boot_id !== PROCESS_BOOT_ID;
      if (!members.length || rebooted || identity.ended) { state = "none"; localGroups.delete(row.turn_id); }
      else if (identity.reused || !sameBoot) state = "unknown";
      else if (known.some(old => members.some(member => sameProcess(old, member))) ||
        (row.turn_id === exitedTurnId && localGroups.has(row.turn_id))) state = "running";
      else state = "unknown";
      if (row.turn_id === exitedTurnId) localGroups.delete(row.turn_id);
      const identities = state === "running" ? JSON.stringify(members.map(({ pid, started }) => ({ pid, started }))) : row.members_json;
      if (state !== row.state || identities !== row.members_json) {
        db.query("UPDATE turn_process_groups SET state = ?, members_json = ?, stop_requested = CASE WHEN ? = 'none' THEN 0 ELSE stop_requested END WHERE turn_id = ?")
          .run(state, identities, state, row.turn_id);
      }
      if (state !== row.state || state === "none") notify(row.task_id);
    }
  });
  refreshing = run.catch(() => {});
  return run;
}

/** One explicit Stop owns admission until active AND older groups are settled. */
export function withProcessStop(taskId: string, work: () => Promise<void>): Promise<void> {
  const existing = stops.get(taskId);
  if (existing) return existing;
  const operation = Promise.resolve().then(work).finally(() => { stops.delete(taskId); notify(taskId); });
  stops.set(taskId, operation);
  notify(taskId);
  return operation;
}

async function signalGroups(taskId: string, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  await refreshProcessGroups(taskId);
  const pending = rows(taskId);
  if (pending.some(row => row.state !== "running" || !Number.isInteger(row.pgid) || row.pgid <= 1)) {
    throw new Error("Background process ownership is uncertain; files are preserved. Inspect the task's background work before retrying Stop.");
  }
  // The immediately preceding inventory validated a living member identity in
  // each group. No await between validation and signalling these owned groups.
  for (const row of pending) {
    try { process.kill(-row.pgid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

export async function stopRecordedGroups(taskId: string, graceMs: number): Promise<void> {
  db.query("UPDATE turn_process_groups SET stop_requested = 1 WHERE task_id = ? AND state != 'none'").run(taskId);
  notify(taskId);
  const ended = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    do {
      await refreshProcessGroups(taskId);
      if (rows(taskId).length === 0) return true;
      await Bun.sleep(50);
    } while (Date.now() < end);
    return false;
  };
  await signalGroups(taskId, "SIGTERM");
  if (await ended(graceMs)) return;
  await signalGroups(taskId, "SIGKILL");
  if (await ended(Math.max(graceMs, 1000))) return;
  throw new Error("Background work has not stopped; files are preserved. Retry Stop before sending or archiving.");
}

/** Deletion checks every recorded turn again, including resumed cleanup jobs. */
export async function assertTaskProcessesEnded(taskId: string): Promise<void> {
  await refreshProcessGroups(taskId);
  if (rows(taskId).length) throw new Error("Background work is still running or unverified; stop it before removing the workspace.");
}

export function startProcessGroupLoop(): { stop(): Promise<void> } {
  let tick: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (tick) return;
    tick = refreshProcessGroups().catch(error => console.error(`[wisp] process inventory: ${String(error)}`)).finally(() => { tick = undefined; });
  }, 2000);
  timer.unref();
  return { async stop() { clearInterval(timer); await tick; } };
}
