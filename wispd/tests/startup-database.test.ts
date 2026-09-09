import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/migrations";

const source = resolve(import.meta.dir, "../src");
const modulePath = (name: string): string => JSON.stringify(join(source, `${name}.ts`));
const startup = `const { serve } = await import(${modulePath("daemon")});`;
const ownership = `const { acquireHomeOwnership, ownsHome } = await import(${modulePath("home-lock")});`;

function fixture(): string {
  const home = mkdtempSync(join(tmpdir(), "wisp-startup-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ token: "startup-fixture-token", host: "127.0.0.1" }));
  writeFileSync(join(home, "adapters.json"), "{}");
  return home;
}

function run(home: string, code: string): string {
  const result = Bun.spawnSync([process.execPath, "-e", code], {
    env: { ...process.env, WISP_HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

/** A populated schema from before the durable process-group migration. */
function seedLegacy(home: string): void {
  const db = new Database(join(home, "wisp.db"));
  db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of MIGRATIONS.filter(entry => entry.id < SCHEMA_VERSION)) {
    migration.up(db);
    db.query("INSERT INTO schema_migrations VALUES (?, ?, 'fixture')").run(migration.id, migration.name);
  }
  db.exec(`INSERT INTO tasks (id, title, repo_path, harness, slot, state, created_at, updated_at)
    VALUES ('tlegacy', 'Keep this task', '/synthetic/repo', 'fake', 0, 'done', 'fixture', 'fixture')`);
  db.close();
}

async function holdHome(home: string): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, "-e", `${ownership}
    acquireHomeOwnership(); console.log('owned'); setInterval(() => {}, 1000);`], {
    env: { ...process.env, WISP_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("owned");
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally { reader.releaseLock(); }
  return child;
}

test("store and daemon imports are inert, and initialization without ownership is refused", () => {
  const home = fixture();
  const output = run(home, `${startup}
    const { initializeStore } = await import(${modulePath("store")});
    try { initializeStore(); } catch (error) { console.log(error.message); }`);
  expect(output).toContain("requires Wisp home ownership");
  expect(existsSync(join(home, "wisp.db"))).toBe(false);
});

test("a contender leaves an older owner's database and config byte-for-byte unchanged", async () => {
  const home = fixture();
  seedLegacy(home);
  const before = readFileSync(join(home, "wisp.db"));
  const config = readFileSync(join(home, "config.json"));
  const owner = await holdHome(home);
  try {
    const output = run(home, `${startup}
      try { await serve({ port: 0 }); throw new Error('unexpected start'); }
      catch (error) { console.log(error.message); }`);
    expect(output).toContain("already being served");
    expect(output).toContain("Keep using the running instance");
    expect(output).toContain("do not delete the lock file");
    expect(readFileSync(join(home, "wisp.db"))).toEqual(before);
    expect(readFileSync(join(home, "config.json"))).toEqual(config);
    expect(existsSync(join(home, "wisp.db-wal"))).toBe(false);
    expect(existsSync(join(home, "instance-id"))).toBe(false);
  } finally {
    // The kernel releases ownership even without graceful cleanup.
    owner.kill("SIGKILL");
    await owner.exited;
  }
  const restarted = run(home, `${startup}
    const server = await serve({ port: 0 });
    const { db, getTask } = await import(${modulePath("store")});
    console.log(JSON.stringify({ title: getTask('tlegacy').title,
      version: db.query('SELECT MAX(id) AS id FROM schema_migrations').get().id }));
    await server.stop(true); process.exit(0);`);
  expect(restarted).toContain('"title":"Keep this task"');
  expect(restarted).toContain(`"version":${SCHEMA_VERSION}`);
}, 20_000);

test("a contender cannot create a missing application database", async () => {
  const home = fixture();
  const owner = await holdHome(home);
  try {
    expect(run(home, `${startup} try { await serve({port: 0}); } catch (error) { console.log(error.message); }`))
      .toContain("changed no tasks");
    expect(existsSync(join(home, "wisp.db"))).toBe(false);
  } finally { owner.kill("SIGKILL"); await owner.exited; }
});

test("a failed migration rolls back its step, releases ownership, and can retry in the same process", () => {
  const home = fixture();
  seedLegacy(home);
  const output = run(home, `${startup} ${ownership}
    const { MIGRATIONS } = await import(${modulePath("migrations")});
    const last = MIGRATIONS.at(-1), original = last.up;
    last.up = db => { db.exec("UPDATE tasks SET title = 'partial upgrade'; CREATE TABLE partial_upgrade (id INTEGER)"); throw new Error('fixture disk full'); };
    try { await serve({ port: 0 }); } catch (error) { console.log(error.message); }
    console.log('released=' + !ownsHome());
    const { Database } = await import('bun:sqlite');
    const check = new Database(process.env.WISP_HOME + '/wisp.db', { readonly: true });
    console.log('rolledBack=' + (check.query("SELECT title FROM tasks").get().title === 'Keep this task'
      && !check.query("SELECT name FROM sqlite_master WHERE name = 'partial_upgrade'").get()
      && check.query('SELECT MAX(id) AS id FROM schema_migrations').get().id === last.id - 1));
    check.close(); last.up = original;
    const server = await serve({ port: 0 });
    console.log('retry=' + (server.port > 0)); await server.stop(true); process.exit(0);`);
  expect(output).toContain("fixture disk full");
  expect(output).toContain("doctor --database");
  expect(output).toContain("No task recovery was started");
  expect(output).toContain("released=true");
  expect(output).toContain("rolledBack=true");
  expect(output).toContain("retry=true");
});

test("future schemas are refused without journal or schema changes, with an upgrade remedy", () => {
  const home = fixture();
  seedLegacy(home);
  const db = new Database(join(home, "wisp.db"));
  db.exec(`INSERT INTO schema_migrations VALUES (${SCHEMA_VERSION + 1}, 'future', 'fixture')`);
  db.close();
  const before = readFileSync(join(home, "wisp.db"));
  const output = run(home, `${startup} ${ownership}
    try { await serve({port: 0}); } catch (error) { console.log(error.message); }
    console.log('released=' + !ownsHome());`);
  expect(output).toContain("Install the same or a newer Wisp version");
  expect(output).toContain("released=true");
  expect(readFileSync(join(home, "wisp.db"))).toEqual(before);
});

test("database-only doctor and ordinary CLI reads never migrate an older profile", async () => {
  const home = fixture();
  seedLegacy(home);
  const before = readFileSync(join(home, "wisp.db"));
  const owner = await holdHome(home);
  try {
    const output = run(home, `process.argv = ['bun', 'wisp', 'doctor', '--database']; await import(${modulePath("index")});`);
    expect(output).toContain(`schema ${SCHEMA_VERSION - 1} of ${SCHEMA_VERSION}`);
    expect(output).not.toContain("harness");
    for (const command of ["help", "version", "token"]) {
      run(home, `process.argv = ['bun', 'wisp', '${command}']; await import(${modulePath("index")});`);
      expect(readFileSync(join(home, "wisp.db"))).toEqual(before);
    }
  } finally { owner.kill("SIGKILL"); await owner.exited; }
});

test("a corrupt database reports diagnosis and preservation steps and releases ownership", () => {
  const home = fixture();
  writeFileSync(join(home, "wisp.db"), "synthetic damaged database");
  const before = readFileSync(join(home, "wisp.db"));
  const output = run(home, `${startup} ${ownership}
    try { await serve({port: 0}); } catch (error) { console.log(error.message); }
    console.log('released=' + !ownsHome());`);
  expect(output).toContain("Could not initialize");
  expect(output).toContain("doctor --database");
  expect(output).toContain("Do not delete the database");
  expect(output).toContain("released=true");
  expect(readFileSync(join(home, "wisp.db"))).toEqual(before);
});

test("shutdown retains ownership through an HTTP-launched turn's final database writes", () => {
  const home = fixture();
  const output = run(home, `${startup} ${ownership}
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const repo = process.env.WISP_HOME + '/repo'; mkdirSync(repo);
    for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture']]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: repo });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    }
    writeFileSync(process.env.WISP_HOME + '/adapters.json', JSON.stringify({ fake: {
      bin: 'bash', exec: ['-c', 'touch ready; for i in {1..100}; do [ -f finish ] && break; sleep .05; done; echo fixture-result'],
      parse: { format: 'text' }, attach: null
    }}));
    const server = await serve({ port: 0 });
    const response = await fetch('http://127.0.0.1:' + server.port + '/api/tasks', {
      method: 'POST', headers: { authorization: 'Bearer startup-fixture-token', 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: repo, prompt: 'fixture', harness: 'fake', mode: 'local' })
    });
    if (response.status !== 201) throw new Error(await response.text());
    const task = await response.json();
    const deadline = Date.now() + 4000;
    while (!existsSync(repo + '/ready') && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(repo + '/ready')) throw new Error('fixture turn did not start');
    let stopped = false;
    const stopping = server.stop(true).then(() => { stopped = true; });
    await Bun.sleep(30);
    console.log('held=' + (ownsHome() && !stopped));
    try { await serve({port: 0}); } catch (error) { console.log(error.message); }
    writeFileSync(repo + '/finish', 'finish');
    await stopping;
    const { getTask } = await import(${modulePath("store")});
    console.log('settled=' + (!ownsHome() && getTask(task.id).state === 'done'));
    const restarted = await serve({port: 0}); await restarted.stop(true); process.exit(0);`);
  expect(output).toContain("held=true");
  expect(output).toContain("already being served");
  expect(output).toContain("settled=true");
}, 20_000);

test("a lock-file open error gives filesystem guidance without creating the application database", () => {
  const home = fixture();
  const output = run(home, `${startup} ${ownership}
    const { mkdirSync, rmdirSync } = await import('node:fs');
    const lock = process.env.WISP_HOME + '/daemon-owner.lock.db'; mkdirSync(lock);
    try { await serve({port: 0}); } catch (error) { console.log(error.message); }
    console.log('released=' + !ownsHome()); rmdirSync(lock);`);
  expect(output).toContain("could not take the daemon ownership lock");
  expect(output).toContain("Check free disk space and permissions");
  expect(output).not.toContain("already being served");
  expect(output).toContain("released=true");
  expect(existsSync(join(home, "wisp.db"))).toBe(false);
});

test("port and config failures release ownership before any database initialization", () => {
  const home = fixture();
  const output = run(home, `${startup} ${ownership}
    const { writeFileSync, existsSync } = await import('node:fs');
    const path = process.env.WISP_HOME + '/config.json'; writeFileSync(path, '{broken');
    try { await serve({port: 0}); } catch (error) { console.log('config=' + error.message); }
    console.log('configReleased=' + !ownsHome());
    writeFileSync(path, JSON.stringify({token: 'startup-fixture-token', host: '127.0.0.1'}));
    const other = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('other')});
    try { await serve({port: other.port}); } catch (error) { console.log('port=' + error.message); }
    console.log('portReleased=' + !ownsHome());
    console.log('untouched=' + !existsSync(process.env.WISP_HOME + '/wisp.db'));
    await other.stop(true); process.exit(0);`);
  expect(output).toContain("configReleased=true");
  expect(output).toContain("already in use");
  expect(output).toContain("portReleased=true");
  expect(output).toContain("untouched=true");
});

test("shutdown retains ownership while an interval delivery awaits its webhook response", () => {
  const home = fixture();
  const output = run(home, `${startup} ${ownership}
    const { writeFileSync } = await import('node:fs');
    let arrived = false, respond;
    const reply = new Promise(resolve => { respond = resolve; });
    const receiver = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => {
      await req.text(); arrived = true; await reply; return new Response('ok');
    }});
    writeFileSync(process.env.WISP_HOME + '/config.json', JSON.stringify({
      token: 'startup-fixture-token', host: '127.0.0.1', webhooks: ['http://127.0.0.1:' + receiver.port]
    }));
    const server = await serve({ port: 0 });
    const { createTask, transition, pendingOutbox } = await import(${modulePath("store")});
    createTask({id: 'twebhook', title: 'Fixture', repo_path: '/synthetic/repo', harness: 'fake', model: null, slot: 0});
    transition('twebhook', 'done');
    const deadline = Date.now() + 8000;
    while (!arrived && Date.now() < deadline) await Bun.sleep(20);
    if (!arrived) throw new Error('webhook did not arrive');
    let stopped = false; const stopping = server.stop(true).then(() => { stopped = true; });
    await Bun.sleep(30); console.log('held=' + (ownsHome() && !stopped));
    respond(); await stopping;
    console.log('delivered=' + (!ownsHome() && pendingOutbox().length === 0));
    await receiver.stop(true); process.exit(0);`);
  expect(output).toContain("held=true");
  expect(output).toContain("delivered=true");
}, 20_000);
