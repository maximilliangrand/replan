import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AUTH_SCHEMA } from './auth.js';
import { principal, workspaceId } from './workspace.js';
import { config } from './config.js';
import type { Action, AuditEvent, Plan, Scenario, Snapshot } from '../shared/contracts.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 8,
  connectionTimeoutMillis: 5000,
});
export type Connection = pg.Pool | pg.PoolClient;
export class Conflict extends Error {
  statusCode = 409;
}
export class Unavailable extends Error {
  statusCode = 503;
}

async function migrations() {
  return [
    {
      version: 1,
      sql: await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'),
    },
    {
      version: 2,
      sql: await readFile(new URL('./migrations/002_workspaces.sql', import.meta.url), 'utf8'),
    },
    { version: 3, sql: AUTH_SCHEMA },
    {
      version: 4,
      sql: await readFile(
        new URL('./migrations/004_operation_sources.sql', import.meta.url),
        'utf8',
      ),
    },
  ];
}
export async function verifySchema() {
  const applied = (
    await pool.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
  ).rows;
  const expected = await migrations();
  if (
    applied.length !== expected.length ||
    expected.some(
      (item, index) =>
        applied[index]?.version !== item.version ||
        applied[index]?.checksum !== createHash('sha256').update(item.sql).digest('hex'),
    )
  )
    throw new Error(
      'Database migration versions do not match this release. Run the migration command before starting.',
    );
}
export async function migrate() {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(782019, 0)');
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const files = await migrations();
    const newest = (await db.query('SELECT max(version) AS version FROM schema_migrations')).rows[0]
      .version;
    if (newest > files.at(-1)!.version)
      throw new Error('Database belongs to a newer release; refusing a schema downgrade.');
    for (const migration of files) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const applied = (
        await db.query('SELECT checksum FROM schema_migrations WHERE version=$1', [
          migration.version,
        ])
      ).rows[0];
      if (applied) {
        if (applied.checksum !== checksum)
          throw new Error(`Migration ${migration.version} changed after it was applied.`);
        continue;
      }
      await db.query(migration.sql);
      await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [
        migration.version,
        checksum,
      ]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

// Held on one dedicated connection, also serializes independent app processes.
// Service calls are outside DB transactions; durable intents survive process death.
export async function withLock<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let locked = false;
  let lockId: number | undefined;
  try {
    lockId = (await db.query('SELECT lock_id FROM workspaces WHERE id=$1', [workspaceId()])).rows[0]
      ?.lock_id;
    if (lockId === undefined) throw new Conflict('Workspace is unavailable.');
    locked = (await db.query('SELECT pg_try_advisory_lock(782019, $1) AS locked', [lockId])).rows[0]
      .locked;
    if (!locked) throw new Conflict('Another operation is running. Refresh and retry.');
    return await fn(db);
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(782019, $1)', [lockId]);
    db.release();
  }
}
export async function transaction<T>(db: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
export async function context(
  db: Connection = pool,
): Promise<{ scenario: Scenario; snapshot: Snapshot; createdAt: Date; crashNext: boolean }> {
  const row = (
    await db.query('SELECT * FROM scenario_state WHERE workspace_id=$1', [workspaceId()])
  ).rows[0];
  if (!row)
    throw new Unavailable(
      'This workspace has no active operation. An administrator must import an operation first.',
    );
  return {
    scenario: row.scenario,
    snapshot: row.snapshot,
    createdAt: row.created_at,
    crashNext: row.crash_next,
  };
}
function actionFromRow(row: pg.QueryResultRow): Action {
  return {
    id: row.id,
    planId: row.plan_id,
    allocation: row.allocation,
    stage: row.stage,
    reservation: row.reservation,
    shipment: row.shipment,
    error: row.error,
  };
}
export async function getPlans(scenarioId: string, db: Connection = pool): Promise<Plan[]> {
  const [p, a] = await Promise.all([
    db.query(
      'SELECT * FROM plans WHERE scenario_id=$1 AND workspace_id=$2 ORDER BY created_at DESC, id',
      [scenarioId, workspaceId()],
    ),
    db.query(
      'SELECT a.* FROM actions a JOIN plans p ON p.id=a.plan_id WHERE p.scenario_id=$1 AND p.workspace_id=$2 ORDER BY a.ordinal',
      [scenarioId, workspaceId()],
    ),
  ]);
  return p.rows.map((row) => ({
    id: row.id,
    scenarioId: row.scenario_id,
    strategy: row.strategy,
    snapshot: row.snapshot,
    solution: row.solution,
    hash: row.hash,
    status: row.status,
    reason: row.reason,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
    actions: a.rows.filter((action) => action.plan_id === row.id).map(actionFromRow),
  }));
}
export async function getPlan(id: string, db: Connection): Promise<Plan> {
  const { scenario } = await context(db);
  const plan = (await getPlans(scenario.id, db)).find((p) => p.id === id);
  if (!plan) throw new Conflict('This plan is not part of the current scenario.');
  return plan;
}
export async function audit(
  db: Connection,
  scenarioId: string,
  kind: string,
  message: string,
  data: Record<string, unknown> = {},
  planId: string | null = null,
  actionId: string | null = null,
) {
  await db.query(
    'INSERT INTO events(scenario_id,kind,message,data,plan_id,action_id,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [scenarioId, kind, message, { ...data, actor: principal() }, planId, actionId, workspaceId()],
  );
}
export async function getEvents(scenarioId: string, db: Connection = pool): Promise<AuditEvent[]> {
  return (
    await db.query('SELECT * FROM events WHERE scenario_id=$1 AND workspace_id=$2 ORDER BY seq', [
      scenarioId,
      workspaceId(),
    ])
  ).rows.map((row) => ({
    seq: Number(row.seq),
    at: row.at.toISOString(),
    planId: row.plan_id,
    actionId: row.action_id,
    kind: row.kind,
    message: row.message,
    data: row.data,
  }));
}
