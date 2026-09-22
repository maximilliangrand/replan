import pg from 'pg';
import { config } from './config.js';
import type { Action, AuditEvent, Plan, Scenario, Snapshot } from '../shared/contracts.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8 });
export type Connection = pg.Pool | pg.PoolClient;
export class Conflict extends Error {
  statusCode = 409;
}
export class Unavailable extends Error {
  statusCode = 503;
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scenario_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      scenario jsonb NOT NULL, snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), crash_next boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS plans (
      id uuid PRIMARY KEY, scenario_id uuid NOT NULL, strategy text NOT NULL,
      snapshot jsonb NOT NULL, solution jsonb NOT NULL, hash text NOT NULL,
      status text NOT NULL CHECK(status IN ('proposed','approved','executing','uncertain','needs_replan','completed','superseded')),
      reason text, created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_plan ON plans(scenario_id)
      WHERE status IN ('approved','executing','uncertain');
    CREATE TABLE IF NOT EXISTS approvals (
      plan_id uuid PRIMARY KEY REFERENCES plans(id), plan_hash text NOT NULL,
      actor text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS actions (
      id text PRIMARY KEY, plan_id uuid NOT NULL REFERENCES plans(id), ordinal integer NOT NULL,
      allocation jsonb NOT NULL, stage text NOT NULL DEFAULT 'pending',
      reservation jsonb, shipment jsonb, error text,
      UNIQUE(plan_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS events (
      seq bigserial PRIMARY KEY, scenario_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
      plan_id uuid REFERENCES plans(id), action_id text REFERENCES actions(id),
      kind text NOT NULL, message text NOT NULL, data jsonb NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_scenario ON events(scenario_id, seq);
  `);
}

// Held on one dedicated connection, also serializes independent app processes.
// Service calls are outside DB transactions; durable intents survive process death.
export async function withLock<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query('SELECT pg_try_advisory_lock(782019, 1) AS locked')).rows[0].locked;
    if (!locked) throw new Conflict('Another operation is running. Refresh and retry.');
    return await fn(db);
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(782019, 1)');
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
  const row = (await db.query('SELECT * FROM scenario_state WHERE singleton')).rows[0];
  if (!row) throw new Unavailable('Scenario is starting. Retry in a moment.');
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
    db.query('SELECT * FROM plans WHERE scenario_id=$1 ORDER BY created_at DESC, id', [scenarioId]),
    db.query(
      'SELECT a.* FROM actions a JOIN plans p ON p.id=a.plan_id WHERE p.scenario_id=$1 ORDER BY a.ordinal',
      [scenarioId],
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
    'INSERT INTO events(scenario_id,kind,message,data,plan_id,action_id) VALUES($1,$2,$3,$4,$5,$6)',
    [scenarioId, kind, message, data, planId, actionId],
  );
}
export async function getEvents(scenarioId: string): Promise<AuditEvent[]> {
  return (
    await pool.query('SELECT * FROM events WHERE scenario_id=$1 ORDER BY seq', [scenarioId])
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
