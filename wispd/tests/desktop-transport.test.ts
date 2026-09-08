import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SEEDER = join(import.meta.dir, "helpers", "seed-transport-daemon.ts");

interface Fixture {
  taskId: string;
  title: string;
  prompt: string;
  output: string;
  attachmentName: string;
  attachmentBase64: string;
}

interface DaemonSpec {
  label: string;
  home: string;
  worktree: string;
  port: number;
  token: string;
  instanceId: string;
  fixture: Fixture;
}

function freePorts(): [number, number] {
  const first = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const second = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const ports: [number, number] = [first.port, second.port];
  first.stop(true);
  second.stop(true);
  return ports;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return await Promise.race([
    promise,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`timed out waiting for ${what}`);
    }),
  ]);
}

async function waitForCondition(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function seed(home: string, label: string, worktree: string): Promise<Fixture> {
  const child = Bun.spawn({
    cmd: [process.execPath, SEEDER, label, worktree],
    cwd: ROOT,
    env: { ...process.env, WISP_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`transport fixture seeding failed: ${stderr.trim()}`);
  return JSON.parse(stdout) as Fixture;
}

async function createSpec(
  label: string,
  port: number,
  token: string,
  instanceId: string,
): Promise<DaemonSpec> {
  const home = mkdtempSync(join(tmpdir(), `wisp-transport-${label}-`));
  try {
    const worktree = join(home, "checkout");
    mkdirSync(join(home, "empty-bin"));
    mkdirSync(worktree);
    writeFileSync(join(home, "instance-id"), `${instanceId}\n`, { mode: 0o600 });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        instanceId,
        port,
        host: "127.0.0.1",
        token,
        webhooks: [],
        repos: [],
        stuckMinutes: 10,
        logMaxBytes: 5_000_000,
        setupTimeoutMinutes: 10,
        envAllowlist: {},
        harnessDefaults: {},
      }),
      { mode: 0o600 },
    );
    const fixture = await seed(home, label, worktree);
    return { label, home, worktree, port, token, instanceId, fixture };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

async function waitForHealth(base: string, spec: DaemonSpec, exited: Promise<number>): Promise<void> {
  let exitCode: number | null = null;
  void exited.then((code) => {
    exitCode = code;
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (exitCode !== null) throw new Error(`daemon exited during startup with code ${exitCode}`);
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        // A parallel test could claim the released ephemeral port and also
        // answer health. Only this fixture's authenticated identity proves the
        // response belongs to the child we spawned.
        const capabilities = await fetch(`${base}/api/capabilities`, {
          headers: { authorization: `Bearer ${spec.token}` },
          signal: AbortSignal.timeout(500),
        });
        const identity = capabilities.ok
          ? ((await capabilities.json()) as { instanceId?: string }).instanceId
          : null;
        await Bun.sleep(25);
        if (exitCode !== null) throw new Error(`daemon exited during startup with code ${exitCode}`);
        if (identity === spec.instanceId) return;
      }
    } catch {
      // The listener is not ready yet.
    }
    await Bun.sleep(50);
  }
  throw new Error(`daemon did not become healthy at ${base}`);
}

async function startDaemon(spec: DaemonSpec) {
  const child = Bun.spawn({
    cmd: [process.execPath, join(ROOT, "src", "index.ts"), "serve"],
    cwd: ROOT,
    // No installed harness CLI, model probe, or agent credential can enter this
    // transport test. The terminal deliberately exercises its supported piped
    // shell fallback because script(1) is absent from this isolated PATH.
    env: {
      ...process.env,
      HOME: spec.home,
      PATH: join(spec.home, "empty-bin"),
      SHELL: "/bin/sh",
      WISP_HOME: spec.home,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${spec.port}`;
  try {
    await waitForHealth(base, spec, child.exited);
  } catch (error) {
    child.kill("SIGTERM");
    await child.exited.catch(() => -1);
    throw new Error(`${String(error)}\nstdout: ${await stdout}\nstderr: ${await stderr}`, { cause: error });
  }
  return { spec, child, stdout, stderr, base };
}

type RunningDaemon = Awaited<ReturnType<typeof startDaemon>>;

async function stopDaemon(daemon: RunningDaemon): Promise<void> {
  daemon.child.kill("SIGTERM");
  try {
    // Terminal shutdown permits 5 seconds for SIGTERM and another 5 for
    // SIGKILL. Give the daemon time to reap its isolated shell before forcing
    // the parent process down.
    await withTimeout(daemon.child.exited, 12_000, `${daemon.spec.label} daemon shutdown`);
  } catch {
    daemon.child.kill("SIGKILL");
    await daemon.child.exited;
  }
  await Promise.all([daemon.stdout, daemon.stderr]);
}

async function startDaemonPair(): Promise<{ specs: DaemonSpec[]; daemons: RunningDaemon[] }> {
  let lastConflict: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [alphaPort, betaPort] = freePorts();
    const specs: DaemonSpec[] = [];
    const daemons: RunningDaemon[] = [];
    try {
      specs.push(
        await createSpec(
          "alpha",
          alphaPort,
          "desktop-transport-token-alpha",
          "10000000-0000-4000-8000-000000000001",
        ),
      );
      specs.push(
        await createSpec(
          "beta",
          betaPort,
          "desktop-transport-token-beta",
          "20000000-0000-4000-8000-000000000002",
        ),
      );
      daemons.push(await startDaemon(specs[0]!));
      daemons.push(await startDaemon(specs[1]!));
      return { specs, daemons };
    } catch (error) {
      for (const daemon of daemons.reverse()) await stopDaemon(daemon);
      for (const spec of specs) rmSync(spec.home, { recursive: true, force: true });
      if (!String(error).includes("already in use")) throw error;
      lastConflict = error;
    }
  }
  throw new Error("could not reserve two daemon ports after 5 attempts", { cause: lastConflict });
}

function authenticatedFetch(
  daemon: RunningDaemon,
  path: string,
  token = daemon.spec.token,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${daemon.base}${path}`, { ...init, headers });
}

interface SseFrame {
  event: string | null;
  data: string;
}

function sseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    async nextFrame(timeoutMs = 5_000): Promise<SseFrame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (raw.startsWith(":")) continue;
          let event: string | null = null;
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            if (line.startsWith("data: ")) data += `${data ? "\n" : ""}${line.slice(6)}`;
          }
          return { event, data };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for an SSE frame");
        pending ??= reader.read();
        const chunk = await Promise.race([pending, Bun.sleep(remaining).then(() => null)]);
        if (chunk === null) continue;
        pending = null;
        if (chunk.done) throw new Error("SSE stream ended before the next frame");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

async function websocketRejected(url: string, token: string): Promise<boolean> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const outcome = await withTimeout(
    new Promise<"opened" | "rejected">((resolve) => {
      socket.onopen = () => resolve("opened");
      socket.onerror = () => resolve("rejected");
      socket.onclose = () => resolve("rejected");
    }),
    5_000,
    "unauthorized terminal rejection",
  );
  socket.close();
  return outcome === "rejected";
}

async function exerciseTerminal(
  daemon: RunningDaemon,
  other: RunningDaemon,
  sockets: WebSocket[],
): Promise<void> {
  const marker = ".transport-terminal-marker";
  const output = "transport-reply";
  const url = `${daemon.base.replace("http://", "ws://")}/api/tasks/${daemon.spec.fixture.taskId}/terminal`;
  expect(await websocketRejected(url, other.spec.token)).toBe(true);

  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${daemon.spec.token}` },
  });
  sockets.push(socket);
  let resolveHello!: (cwd: string) => void;
  let resolveOutput!: () => void;
  let resolveExit!: () => void;
  let rejectHello!: (error: Error) => void;
  let rejectOutput!: (error: Error) => void;
  let rejectExit!: (error: Error) => void;
  const hello = new Promise<string>((resolve, rejectPromise) => {
    resolveHello = resolve;
    rejectHello = rejectPromise;
  });
  const receivedOutput = new Promise<void>((resolve, rejectPromise) => {
    resolveOutput = resolve;
    rejectOutput = rejectPromise;
  });
  const exited = new Promise<void>((resolve, rejectPromise) => {
    resolveExit = resolve;
    rejectExit = rejectPromise;
  });
  socket.onerror = () => {
    const error = new Error("authorized terminal websocket failed");
    rejectHello(error);
    rejectOutput(error);
    rejectExit(error);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; cwd?: string; data?: string };
    if (message.type === "hello") resolveHello(message.cwd ?? "");
    if (message.type === "out" && message.data?.includes(output)) resolveOutput();
    if (message.type === "exit") resolveExit();
  };

  expect(await withTimeout(hello, 10_000, "terminal hello")).toBe(daemon.spec.worktree);
  try {
    socket.send(
      JSON.stringify({
        type: "in",
        data: `printf '%s' 'alpha' > ${marker}; printf '\\164\\162\\141\\156\\163\\160\\157\\162\\164\\055\\162\\145\\160\\154\\171\\n'\n`,
      }),
    );
    await withTimeout(receivedOutput, 10_000, "terminal output");
    await waitForCondition(
      () => existsSync(join(daemon.spec.worktree, marker)),
      5_000,
      "terminal marker file",
    );
    expect(readFileSync(join(daemon.spec.worktree, marker), "utf8")).toBe("alpha");
    expect(existsSync(join(other.spec.worktree, marker))).toBe(false);
  } finally {
    const archive = await authenticatedFetch(daemon, `/api/tasks/${daemon.spec.fixture.taskId}/archive`, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(archive.status).toBe(200);
    await withTimeout(exited, 10_000, "terminal exit after archive");
  }
}

describe("desktop upstream transport against two real daemons", () => {
  test(
    "keeps overlapping task IDs, streams, attachments, and terminal traffic scoped to their daemon",
    { timeout: 60_000 },
    async () => {
      let specs: DaemonSpec[] = [];
      let daemons: RunningDaemon[] = [];
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      const sockets: WebSocket[] = [];
      try {
        ({ specs, daemons } = await startDaemonPair());
        const [alpha, beta] = daemons;

        const alphaCapabilityResponse = await authenticatedFetch(alpha!, "/api/capabilities");
        const betaCapabilityResponse = await authenticatedFetch(beta!, "/api/capabilities");
        expect(alphaCapabilityResponse.status).toBe(200);
        expect(betaCapabilityResponse.status).toBe(200);
        const alphaCapabilities = (await alphaCapabilityResponse.json()) as { instanceId: string };
        const betaCapabilities = (await betaCapabilityResponse.json()) as { instanceId: string };
        expect(alphaCapabilities.instanceId).toBe(alpha!.spec.instanceId);
        expect(betaCapabilities.instanceId).toBe(beta!.spec.instanceId);
        expect(alphaCapabilities.instanceId).not.toBe(betaCapabilities.instanceId);

        expect((await authenticatedFetch(alpha!, "/api/capabilities", beta!.spec.token)).status).toBe(401);
        expect((await authenticatedFetch(beta!, "/api/tasks", alpha!.spec.token)).status).toBe(401);
        expect((await fetch(`${alpha!.base}/api/tasks`)).status).toBe(401);

        const alphaTasksResponse = await authenticatedFetch(alpha!, "/api/tasks");
        const betaTasksResponse = await authenticatedFetch(beta!, "/api/tasks");
        const alphaTasks = (await alphaTasksResponse.json()) as Array<{ id: string; title: string }>;
        const betaTasks = (await betaTasksResponse.json()) as Array<{ id: string; title: string }>;
        expect(alphaTasks).toHaveLength(1);
        expect(betaTasks).toHaveLength(1);
        expect(alphaTasks[0]).toMatchObject({ id: alpha!.spec.fixture.taskId, title: alpha!.spec.fixture.title });
        expect(betaTasks[0]).toMatchObject({ id: beta!.spec.fixture.taskId, title: beta!.spec.fixture.title });
        expect(alphaTasks[0]!.id).toBe(betaTasks[0]!.id);

        const alphaEventsResponse = await authenticatedFetch(alpha!, "/api/events");
        const betaEventsResponse = await authenticatedFetch(beta!, "/api/events");
        expect(alphaEventsResponse.status).toBe(200);
        expect(betaEventsResponse.status).toBe(200);
        const alphaEventsBody = alphaEventsResponse.body!.getReader();
        const betaEventsBody = betaEventsResponse.body!.getReader();
        readers.push(alphaEventsBody, betaEventsBody);
        const alphaEvents = sseReader(alphaEventsBody);
        const betaEvents = sseReader(betaEventsBody);
        const renamedTitle = "transport task alpha renamed";
        const renameResponse = await authenticatedFetch(alpha!, `/api/tasks/${alpha!.spec.fixture.taskId}`, undefined, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: renamedTitle }),
        });
        expect(renameResponse.status).toBe(200);
        expect((await renameResponse.json()) as { title: string }).toMatchObject({ title: renamedTitle });
        const alphaEvent = await alphaEvents.nextFrame();
        expect(JSON.parse(alphaEvent.data)).toMatchObject({
          type: "task",
          taskId: alpha!.spec.fixture.taskId,
          title: renamedTitle,
        });
        const betaPending = betaEvents.nextFrame(5_000);
        const betaOutcome = await Promise.race([betaPending, Bun.sleep(600).then(() => null)]);
        expect(betaOutcome).toBeNull();
        await betaEventsBody.cancel();
        await betaPending.catch(() => null);

        for (const daemon of [alpha!, beta!]) {
          const logResponse = await authenticatedFetch(
            daemon,
            `/api/tasks/${daemon.spec.fixture.taskId}/log/stream?turn=1&format=raw`,
          );
          expect(logResponse.status).toBe(200);
          const logBody = logResponse.body!.getReader();
          readers.push(logBody);
          const backlog = await sseReader(logBody).nextFrame();
          expect(backlog.event).toBe("backlog");
          expect(JSON.parse(backlog.data)).toEqual({
            turn: 1,
            prompt: daemon.spec.fixture.prompt,
            text: daemon.spec.fixture.output,
          });
          await logBody.cancel();

          const attachmentResponse = await authenticatedFetch(
            daemon,
            `/api/tasks/${daemon.spec.fixture.taskId}/attachments/1/${daemon.spec.fixture.attachmentName}`,
          );
          expect(attachmentResponse.status).toBe(200);
          expect(attachmentResponse.headers.get("content-type")).toBe("image/png");
          expect(Buffer.from(await attachmentResponse.arrayBuffer())).toEqual(
            Buffer.from(daemon.spec.fixture.attachmentBase64, "base64"),
          );
        }

        await exerciseTerminal(alpha!, beta!, sockets);
      } finally {
        for (const socket of sockets) socket.close();
        for (const reader of readers) await reader.cancel().catch(() => undefined);
        for (const daemon of daemons.reverse()) await stopDaemon(daemon);
        for (const spec of specs) rmSync(spec.home, { recursive: true, force: true });
      }
    },
  );
});
