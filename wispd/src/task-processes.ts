import { PROCESS_BOOT_ID } from "./process-boot";
import { emit } from "./events";
import { db, getTask, getTurn } from "./store";
import { processNames, processSnapshot, sameProcess, type GroupMember, type ProcessMember } from "./process-snapshot";
import type { BackgroundGroup, BackgroundWork } from "./types";

interface GroupRow {
  turn_id: number; task_id: string; pgid: number; boot_id: string | null; members_json: string;
  state: "none" | "running" | "unknown"; stop_requested: number;
}

/**
 * How long a just-finished turn's group may take to disperse before the badge
 * calls it background work.
 *
 * A harness can leave a shell, `git` or `gh` child in the turn's group for a
 * second or two after the turn is marked done — codex did it on 5 of 6 turns
 * in the report that prompted this. The 2s inventory catches the straggler and
 * the task flashes "Background work running" for one poll, which teaches the
 * operator that the badge means nothing. A badge that cries wolf is worse than
 * no badge, so the REPORTED state waits one beat.
 *
 * Only the report waits. `assertTaskProcessesEnded`, archive admission and
 * Stop all read the raw rows, so no file is deleted and no process is signalled
 * on the strength of this delay.
 */
export const BACKGROUND_SETTLE_MS = 5_000;

const localGroups = new Set<number>();
const stops = new Map<string, Promise<void>>();
/** turn id → program names at the last inventory. Memory only: a name is never an identity. */
const liveNames = new Map<number, string[]>();
/** turn ids already reported as settled background work, so the badge is announced once. */
const announced = new Set<number>();
/** turn id → the pid set already named, so an unchanged group is never re-named. */
const namedPids = new Map<number, string>();
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

/** Identities as they were persisted, ignoring anything that is not one. */
function knownMembers(membersJson: string): ProcessMember[] {
  try {
    const parsed: unknown = JSON.parse(membersJson);
    return Array.isArray(parsed) ? parsed.filter((value): value is ProcessMember =>
      value !== null && typeof value === "object" && Number.isInteger(value.pid) &&
      (typeof value.started === "string" || value.started === null)) : [];
  } catch { return []; }
}

/** True while a finished turn's group is still inside its settle window. */
function settling(turn: ReturnType<typeof getTurn>, settleMs: number): boolean {
  if (settleMs <= 0 || !turn?.ended_at) return false;
  const ended = Date.parse(turn.ended_at);
  return Number.isFinite(ended) && Date.now() - ended < settleMs;
}

/** Reported when a group is background work: what it is, not just that it is. */
function describe(group: GroupRow[]): BackgroundGroup[] {
  return group.map(row => {
    const turn = getTurn(row.turn_id);
    return {
      turn: turn?.n ?? row.turn_id,
      pgid: row.pgid,
      processes: knownMembers(row.members_json).length,
      since: turn?.ended_at ?? null,
      state: row.state === "running" ? "running" as const : "unknown" as const,
      stopRequested: row.stop_requested !== 0,
      names: liveNames.get(row.turn_id) ?? [],
    };
  });
}

/**
 * Agent outcome stays on the task; background work is a separate resource fact.
 *
 * `settleMs` is for the report only — the API passes `BACKGROUND_SETTLE_MS` so
 * a straggler that dies with its turn never reaches the badge. Every caller
 * that deletes, archives or signals passes nothing and sees every row.
 */
export function backgroundWork(taskId: string, settleMs = 0): BackgroundWork {
  const all = rows(taskId);
  const background = all.filter(row => {
    const turn = getTurn(row.turn_id);
    return turn?.status !== "running" && !settling(turn, settleMs);
  });
  if (stops.has(taskId)) return { state: "stopping", groups: all.length, details: describe(all) };
  const details = describe(background);
  if (background.some(row => row.state === "unknown" || row.stop_requested)) return { state: "unknown", groups: background.length, details };
  return { state: background.length ? "running" : "none", groups: background.length, details };
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

/**
 * Name what survived, after the inventory has already decided ownership.
 *
 * Memoized on the group's exact pid set, which is what keeps this affordable:
 * `stopRecordedGroups` drains by calling the refresh every 50ms, and naming
 * the same unchanged pids on every pass would double this daemon's subprocess
 * rate for the length of a Stop. The suite's known timeout flakes come from
 * process-creation contention, so a description must not buy itself one.
 *
 * Names live in memory because they are a description, not an identity:
 * persisting them would put a string `ps` happened to report next to the
 * pid/start-time pair that authorizes a signal.
 */
async function nameGroups(groups: { turnId: number; pids: number[] }[]): Promise<void> {
  const fresh = groups.filter(group => namedPids.get(group.turnId) !== group.pids.join(","));
  if (!fresh.length) return;
  const named = await processNames(fresh.flatMap(group => group.pids));
  if (!named.size) return;
  for (const group of fresh) {
    const names = [...new Set(group.pids.map(pid => named.get(pid)).filter((name): name is string => Boolean(name)))];
    namedPids.set(group.turnId, group.pids.join(","));
    if (names.length) liveNames.set(group.turnId, names);
    else liveNames.delete(group.turnId);
  }
}

/** What one inventory says about one recorded group. Ownership lives here alone. */
function groupState(
  row: GroupRow,
  members: GroupMember[],
  turn: ReturnType<typeof getTurn>,
  exitedTurnId?: number,
): GroupRow["state"] {
  const leader = members.find(member => member.pid === row.pgid);
  // Never adopt a group whose leader has a different identity. Even an
  // apparent start-time mismatch can be a locale/timezone change in old ps
  // timestamps, so preserve files instead of assuming the old work ended.
  const identity = historicalGroupIdentity(row, leader, turn);
  const sameBoot = row.boot_id !== null && PROCESS_BOOT_ID !== null && row.boot_id === PROCESS_BOOT_ID;
  const rebooted = row.boot_id !== null && PROCESS_BOOT_ID !== null && row.boot_id !== PROCESS_BOOT_ID;
  if (!members.length || rebooted || identity.ended) return "none";
  if (identity.reused || !sameBoot) return "unknown";
  const recognized = knownMembers(row.members_json).some(old => members.some(member => sameProcess(old, member)));
  return recognized || (row.turn_id === exitedTurnId && localGroups.has(row.turn_id)) ? "running" : "unknown";
}

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
    const living: { turnId: number; pids: number[] }[] = [];
    for (const row of pending) {
      const members = inventory.filter(member => member.pgid === row.pgid);
      const original = getTurn(row.turn_id);
      const state = groupState(row, members, original, exitedTurnId);
      if (state === "none" || row.turn_id === exitedTurnId) localGroups.delete(row.turn_id);
      const identities = state === "running" ? JSON.stringify(members.map(({ pid, started }) => ({ pid, started }))) : row.members_json;
      if (state !== row.state || identities !== row.members_json) {
        db.query("UPDATE turn_process_groups SET state = ?, members_json = ?, stop_requested = CASE WHEN ? = 'none' THEN 0 ELSE stop_requested END WHERE turn_id = ?")
          .run(state, identities, state, row.turn_id);
      }
      // A group that merely OUTLIVES its settle window changes no column, so
      // the state comparison below would never announce it. Emit once when it
      // crosses, or the badge it earned would wait for an unrelated event.
      const reportable = state !== "none" && original?.status !== "running" && !settling(original, BACKGROUND_SETTLE_MS);
      if (state === "none") { liveNames.delete(row.turn_id); namedPids.delete(row.turn_id); announced.delete(row.turn_id); }
      // Only groups the report will actually show are worth a naming call.
      else if (reportable) living.push({ turnId: row.turn_id, pids: members.map(member => member.pid) });
      const crossed = reportable && !announced.has(row.turn_id);
      if (crossed) announced.add(row.turn_id);
      if (state !== row.state || state === "none" || crossed) notify(row.task_id);
    }
    await nameGroups(living);
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
    throw new Error("Background process ownership is uncertain; files are preserved. The task's background detail lists the tracked groups and what they are running; check them before retrying Stop.");
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
