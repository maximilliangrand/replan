import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { makeScenario } from '../src/scenario.js';

const exec = promisify(execFile);
const url =
  process.env.TEST_AUTH_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_auth_test';
const schema = `migration_${randomUUID().replaceAll('-', '')}`;
const db = new pg.Client({ connectionString: url });
const scenario = makeScenario().scenario;
const planId = randomUUID();
const workspace = '00000000-0000-4000-8000-000000000001';
const snapshot = { observedAt: '2026-01-01T00:00:00.000Z', stock: [] };
async function run(command: string) {
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  return exec(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import {migrate,verifySchema,pool} from './src/db.ts'; try { ${command} } finally { await pool.end(); }`,
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: scoped.toString(),
        NODE_ENV: 'test',
        REPLAN_MODE: 'demo',
      },
      timeout: 15_000,
    },
  );
}
beforeAll(async () => {
  await db.connect();
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  await db.query(
    await readFile(new URL('../src/migrations/001_initial.sql', import.meta.url), 'utf8'),
  );
  await db.query('INSERT INTO scenario_state(scenario,snapshot) VALUES($1,$2)', [
    scenario,
    snapshot,
  ]);
  await db.query(
    "INSERT INTO plans(id,scenario_id,strategy,snapshot,solution,hash,status) VALUES($1,$2,'optimized',$3,'{}',$4,'approved')",
    [planId, scenario.id, snapshot, 'a'.repeat(64)],
  );
  await db.query("INSERT INTO approvals(plan_id,plan_hash,actor) VALUES($1,$2,'Demo operator')", [
    planId,
    'a'.repeat(64),
  ]);
  await db.query(
    "INSERT INTO actions(id,plan_id,ordinal,allocation,stage) VALUES($1,$2,0,'{}','dispatch_unknown')",
    [`${planId}:0`, planId],
  );
  await db.query(
    "INSERT INTO events(scenario_id,plan_id,kind,message) VALUES($1,$2,'action.dispatching','Durable dispatch intent')",
    [scenario.id, planId],
  );
});
afterAll(async () => {
  await db.query(`DROP SCHEMA ${schema} CASCADE`);
  await db.end();
});
it('upgrades released data without losing approvals, uncertain actions or history; reruns safely', async () => {
  await run('await migrate(); await verifySchema();');
  await run('await migrate(); await verifySchema();');
  expect(
    (await db.query('SELECT workspace_id,scenario,snapshot FROM scenario_state')).rows,
  ).toEqual([{ workspace_id: workspace, scenario, snapshot }]);
  expect(
    (await db.query('SELECT status,workspace_id,cancel_reason FROM plans WHERE id=$1', [planId]))
      .rows[0],
  ).toEqual({ status: 'approved', workspace_id: workspace, cancel_reason: null });
  expect((await db.query('SELECT actor,actor_id FROM approvals')).rows[0]).toEqual({
    actor: 'Demo operator',
    actor_id: null,
  });
  expect((await db.query('SELECT stage FROM actions')).rows[0].stage).toBe('dispatch_unknown');
  expect((await db.query('SELECT workspace_id,kind FROM events')).rows).toEqual([
    { workspace_id: workspace, kind: 'action.dispatching' },
  ]);
  expect((await db.query('SELECT scenario_id,workspace_id FROM operation_sources')).rows).toEqual([
    { scenario_id: scenario.id, workspace_id: workspace },
  ]);
  expect(
    (await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
      (r) => r.version,
    ),
  ).toEqual([1, 2, 3, 4]);
});
it('fails closed on altered or missing migration history', async () => {
  const checksum = (await db.query('SELECT checksum FROM schema_migrations WHERE version=2'))
    .rows[0].checksum;
  await db.query("UPDATE schema_migrations SET checksum='tampered' WHERE version=2");
  await expect(run('await migrate();')).rejects.toThrow('changed after it was applied');
  await expect(run('await verifySchema();')).rejects.toThrow('do not match this release');
  await db.query('UPDATE schema_migrations SET checksum=$1 WHERE version=2', [checksum]);
  await run('await verifySchema();');
  expect((await db.query('SELECT count(*)::int AS count FROM actions')).rows[0].count).toBe(1);
});

it('refuses an older application against a newer database schema', async () => {
  await db.query("INSERT INTO schema_migrations(version,checksum) VALUES(999,'future')");
  try {
    await expect(run('await migrate();')).rejects.toThrow('newer release');
    await expect(run('await verifySchema();')).rejects.toThrow('do not match this release');
  } finally {
    await db.query('DELETE FROM schema_migrations WHERE version=999');
  }
});
