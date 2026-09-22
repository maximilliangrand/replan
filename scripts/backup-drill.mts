import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import pg from 'pg';
import { provisionOperator } from '../src/auth.js';
import { makeScenario } from '../src/scenario.js';
import type { Solution } from '../shared/contracts.js';

// This drill never dumps, restores into, truncates or drops an existing database.
// It creates two unpredictable databases on an explicitly selected test cluster.
const adminUrl = new URL(
  process.env.BACKUP_ADMIN_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://replan@127.0.0.1:55432/replan_test',
);
if (
  !['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
  !adminUrl.pathname.endsWith('_test')
)
  throw new Error(
    'Select a test cluster via BACKUP_ADMIN_DATABASE_URL; its database name must end in _test.',
  );
const root = resolve(import.meta.dirname, '..');
const admin = new pg.Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
const suffix = randomBytes(8).toString('hex');
const names = [`replan_backup_${suffix}_test`, `replan_restore_${suffix}_test`];
const created = new Set<string>();
const opened: pg.Pool[] = [];
let directory: string | undefined;
const started = performance.now();

function databaseUrl(name: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url;
}
function pgTool(name: string) {
  return process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
}
function pgEnvironment(url: URL): NodeJS.ProcessEnv {
  // Keep passwords out of the process argument list and all command output.
  const options: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '10',
  };
  for (const [key, value] of url.searchParams) {
    if (!(key in options)) throw new Error(`Unsupported backup connection option: ${key}.`);
    env[options[key]] = value;
  }
  return env;
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${basename(command)} failed; verify the client version and test database permissions.`,
    );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function fingerprint(pool: pg.Pool) {
  const tables = (
    await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  ).rows;
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected table name in drill.');
    const rows = (
      await pool.query(`SELECT to_jsonb(t)::text AS row FROM public."${tablename}" t ORDER BY 1`)
    ).rows;
    result[tablename] = {
      rows: rows.length,
      sha256: createHash('sha256')
        .update(rows.map(({ row }) => row).join('\n'))
        .digest('hex'),
    };
  }
  return result;
}

try {
  directory = await mkdtemp(join(tmpdir(), 'replan-backup-drill-'));
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}"`);
    created.add(name);
  }
  const sourceUrl = databaseUrl(names[0]);
  const restoreUrl = databaseUrl(names[1]);
  run(process.execPath, ['--import', 'tsx', 'scripts/migrate.mts'], {
    ...process.env,
    DATABASE_URL: sourceUrl.toString(),
    REPLAN_MODE: 'demo',
    NODE_ENV: 'test',
  });
  const source = new pg.Pool({ connectionString: sourceUrl.toString() });
  const restored = new pg.Pool({ connectionString: restoreUrl.toString() });
  opened.push(source, restored);
  const workspaceId = randomUUID();
  await source.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
    workspaceId,
    'Restore drill only',
  ]);
  const { principal } = await provisionOperator(source, {
    name: 'Restore drill operator',
    role: 'operator',
    workspaceId,
  });
  const { scenario, stock } = makeScenario();
  const snapshot = { observedAt: new Date().toISOString(), stock };
  const allocation = {
    orderId: scenario.orders[0].id,
    warehouse: stock[0].warehouse,
    part: stock[0].part,
    quantity: 4,
    laneId: scenario.lanes[0].id,
    mode: scenario.lanes[0].mode,
    hours: 3,
    cost: 180,
    stockVersion: 1,
  };
  const solution: Solution = {
    allocations: [allocation],
    unfilled: scenario.orders.slice(1).map((order) => order.id),
    totalCost: 180,
    fulfilledPriority: 10,
    solverStatus: 'DRILL_FIXTURE',
    solveMs: 0,
    explanation: 'Synthetic backup fixture with an unresolved dispatch intent.',
  };
  const planId = randomUUID();
  const actionId = `${planId}:0`;
  const hash = createHash('sha256')
    .update(canonical({ scenarioId: scenario.id, strategy: 'greedy', snapshot, solution }))
    .digest('hex');
  await source.query(
    'INSERT INTO operation_sources(scenario_id,workspace_id,source) VALUES($1,$2,$3)',
    [scenario.id, workspaceId, 'Temporary restore-drill fixture'],
  );
  await source.query(
    'INSERT INTO scenario_state(workspace_id,scenario,snapshot) VALUES($1,$2,$3)',
    [workspaceId, scenario, snapshot],
  );
  await source.query(
    "INSERT INTO plans(id,scenario_id,strategy,snapshot,solution,hash,status,workspace_id,approved_at) VALUES($1,$2,'greedy',$3,$4,$5,'uncertain',$6,now())",
    [planId, scenario.id, snapshot, solution, hash, workspaceId],
  );
  await source.query(
    'INSERT INTO approvals(plan_id,plan_hash,actor,actor_id) VALUES($1,$2,$3,$4)',
    [planId, hash, principal.name, principal.id],
  );
  await source.query(
    "INSERT INTO actions(id,plan_id,ordinal,allocation,stage,error) VALUES($1,$2,0,$3,'dispatch_unknown','Synthetic lost response')",
    [actionId, planId, allocation],
  );
  await source.query(
    "INSERT INTO events(scenario_id,plan_id,action_id,workspace_id,kind,message,data) VALUES($1,$2,$3,$4,'action.dispatching','Synthetic durable intent before dispatch',$5)",
    [scenario.id, planId, actionId, workspaceId, { actor: principal }],
  );
  const before = await fingerprint(source);
  const dump = join(directory, 'application.dump');
  await writeFile(dump, '', { mode: 0o600 });
  run(
    pgTool('pg_dump'),
    ['--format=custom', '--no-owner', '--no-acl', '--file', dump],
    pgEnvironment(sourceUrl),
  );
  run(
    pgTool('pg_restore'),
    ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', names[1], dump],
    pgEnvironment(restoreUrl),
  );
  const after = await fingerprint(restored);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Restored table contents do not match their source.');
  const oldSequence = Number(
    (await restored.query('SELECT max(seq) AS seq FROM events')).rows[0].seq,
  );
  const nextSequence = Number(
    (
      await restored.query(
        "INSERT INTO events(scenario_id,workspace_id,kind,message) VALUES($1,$2,'drill.verified','Sequence restore verified') RETURNING seq",
        [scenario.id, workspaceId],
      )
    ).rows[0].seq,
  );
  if (nextSequence <= oldSequence) throw new Error('Restored event sequence did not advance.');
  process.stdout.write(
    `${JSON.stringify({ valid: true, fixture: 'synthetic application database with approval and unknown dispatch', tables: before, sequenceAdvanced: true, elapsedMs: Math.round(performance.now() - started), scope: 'Application database restore only; no external provider state or live recovery claim.' }, null, 2)}\n`,
  );
} catch (error) {
  const message =
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Backup drill failed; verify the isolated test cluster and database privileges.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all(opened.map((pool) => pool.end()));
  for (const name of created) {
    try {
      await admin.query(`DROP DATABASE "${name}"`);
    } catch {
      process.stderr.write(
        `Could not remove drill-owned database ${name}; remove it after checking for open drill connections.\n`,
      );
      process.exitCode = 1;
    }
  }
  await admin.end();
  if (directory && existsSync(directory)) await rm(directory, { recursive: true });
}
