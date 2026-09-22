import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppState, Plan } from '../shared/contracts.js';
import { createInventory } from '../src/simulators/inventory.js';
import { createCarrier } from '../src/simulators/carrier.js';
import { verifyEvidence } from '../src/replay.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_test';
const inventoryDatabase =
  process.env.TEST_INVENTORY_DATABASE_URL ??
  'postgres://replan@127.0.0.1:55432/replan_inventory_test';
const carrierDatabase =
  process.env.TEST_CARRIER_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_carrier_test';
const db = new pg.Pool({ connectionString: databaseUrl });
const inventoryDb = new pg.Pool({ connectionString: inventoryDatabase });
const carrierDb = new pg.Pool({ connectionString: carrierDatabase });
let inventory: FastifyInstance;
let carrier: FastifyInstance;
let child: ChildProcess;
let base: string;
let inventoryUrl: string;
let carrierUrl: string;
let corruptNextReservationReceipt = false;
let logs = '';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      INVENTORY_URL: inventoryUrl,
      CARRIER_URL: carrierUrl,
      PROVIDER_TIMEOUT_MS: '1500',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (chunk) => {
    logs += chunk;
  });
  child.stderr!.on('data', (chunk) => {
    logs += chunk;
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* startup */
    }
    if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}: ${logs}`);
    await sleep(50);
  }
  throw new Error(`App did not start: ${logs}`);
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
  }
}
async function call(path: string, body?: unknown, status = 200): Promise<AppState> {
  const response = await fetch(base + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result as AppState;
}
async function proposal(strategy = 'optimized') {
  const s = await call('/plans', { strategy });
  return s.plans[0];
}
async function approved() {
  const p = await proposal();
  await call(`/plans/${p.id}/approve`, { hash: p.hash });
  return p;
}
const from = (s: AppState, p: Plan) => s.plans.find((x) => x.id === p.id)!;

beforeAll(async () => {
  // Dedicated *_test databases only; no TRUNCATE or reset of any developer data.
  inventory = await createInventory(inventoryDatabase);
  inventory.addHook('onSend', async (request, reply, payload) => {
    if (
      corruptNextReservationReceipt &&
      request.method === 'POST' &&
      request.url === '/reservations' &&
      reply.statusCode === 201
    ) {
      corruptNextReservationReceipt = false;
      const receipt = JSON.parse(payload as string) as Record<string, unknown>;
      return JSON.stringify({ ...receipt, key: 'receipt-for-another-action' });
    }
    return payload;
  });
  carrier = await createCarrier(carrierDatabase);
  inventoryUrl = await inventory.listen({ host: '127.0.0.1', port: 0 });
  carrierUrl = await carrier.listen({ host: '127.0.0.1', port: 0 });
  await start();
});
beforeEach(async () => {
  corruptNextReservationReceipt = false;
  await call('/demo/reset', {});
});
afterAll(async () => {
  await stop();
  await Promise.all([
    inventory?.close(),
    carrier?.close(),
    db.end(),
    inventoryDb.end(),
    carrierDb.end(),
  ]);
});

describe('approved transfers against independently persistent providers', () => {
  it('exports consistent idle evidence and refuses snapshots during an operation', async () => {
    const p = await approved();
    const lock = await db.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(782019, 1)');
      await call('/audit', undefined, 409);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(782019, 1)');
      lock.release();
    }
    await call(`/plans/${p.id}/execute`, {});
    const evidence = await call('/audit');
    expect(verifyEvidence(evidence).valid).toBe(true);
  });
  it('rejects execution without approval, wrong approval fingerprints and remote origins', async () => {
    const p = await proposal();
    await call(`/plans/${p.id}/execute`, {}, 409);
    await call(`/plans/${p.id}/approve`, { hash: '0'.repeat(64) }, 409);
    const r = await fetch(base + '/api/demo/reset', {
      method: 'POST',
      headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(403);
    expect((await call('/state')).world?.shipments).toHaveLength(0);
  });
  it('dispatches each approved order once; duplicate execution and recovery are idempotent', async () => {
    const p = await approved();
    const s = await call(`/plans/${p.id}/execute`, {});
    expect(from(s, p).status).toBe('completed');
    expect(s.world?.shipments).toHaveLength(3);
    expect(s.world?.reservations.every((r) => r.status === 'consumed')).toBe(true);
    await call(`/plans/${p.id}/execute`, {});
    const again = await call(`/plans/${p.id}/recover`, {});
    expect(again.world?.shipments).toHaveLength(3);
    expect(again.world?.stock.every((row) => row.available >= 0)).toBe(true);
  });
  it('freezes approval: a changed input observation does not rewrite the approved proposal', async () => {
    const p = await approved();
    const a = p.actions[0].allocation;
    await call('/demo/consume', { warehouse: a.warehouse, part: a.part, quantity: 1 });
    const refreshed = await call('/observe', {});
    expect(from(refreshed, p).snapshot).toEqual(p.snapshot);
    expect(from(refreshed, p).hash).toBe(p.hash);
    const s = await call(`/plans/${p.id}/execute`, {});
    expect(from(s, p).status).toBe('needs_replan');
    expect(s.world?.shipments).toHaveLength(0);
  });
  it('holds execution when a successful reservation returns valid-shaped evidence for another action', async () => {
    const plan = await approved();
    corruptNextReservationReceipt = true;
    const uncertain = await call(`/plans/${plan.id}/execute`, {});
    expect(corruptNextReservationReceipt).toBe(false);
    expect(from(uncertain, plan).status).toBe('uncertain');
    expect(from(uncertain, plan).actions[0].stage).toBe('reserving');
    expect(from(uncertain, plan).actions[0].error).toContain('conflicts with the approved action');
    expect(uncertain.world?.shipments).toEqual([]);
    expect(uncertain.world?.reservations).toHaveLength(1);
    expect(uncertain.world?.reservations[0]).toMatchObject({
      key: plan.actions[0].id,
      status: 'held',
    });
    expect(uncertain.events.some((event) => event.kind === 'action.dispatching')).toBe(false);
    await call('/plans', { strategy: 'optimized' }, 409);
    const recovered = await call(`/plans/${plan.id}/recover`, {});
    expect(from(recovered, plan).status).toBe('completed');
    expect(recovered.world?.shipments).toHaveLength(3);
    expect(new Set(recovered.world?.shipments.map((shipment) => shipment.key)).size).toBe(3);
  });
  it('keeps completed transfers when later stock changes, requiring fresh approval for the remainder', async () => {
    const p = await approved();
    const partial = await call(`/plans/${p.id}/step`, {});
    expect(partial.world?.shipments).toHaveLength(1);
    const next = from(partial, p).actions.find((a) => a.stage === 'pending')!.allocation;
    await call('/demo/consume', { warehouse: next.warehouse, part: next.part, quantity: 1 });
    const blocked = await call(`/plans/${p.id}/execute`, {});
    expect(from(blocked, p).status).toBe('needs_replan');
    expect(blocked.world?.shipments).toHaveLength(1);
    await call('/observe', {});
    const replacement = await proposal();
    const completed = partial.world!.shipments[0].orderId;
    expect(replacement.actions.some((a) => a.allocation.orderId === completed)).toBe(false);
    await call(`/plans/${replacement.id}/execute`, {}, 409);
    await call(`/plans/${replacement.id}/approve`, { hash: replacement.hash });
    const final = await call(`/plans/${replacement.id}/execute`, {});
    expect(from(final, replacement).status).toBe('completed');
    expect(final.world?.shipments).toHaveLength(3);
    expect(new Set(final.world?.shipments.map((s) => s.orderId)).size).toBe(3);
  });
  it('treats an accepted-but-lost response as unknown and reconciles without another commitment', async () => {
    const p = await approved();
    await call('/demo/fault', { fault: 'lost_response' });
    const uncertain = await call(`/plans/${p.id}/execute`, {});
    expect(from(uncertain, p).status).toBe('uncertain');
    expect(from(uncertain, p).actions[0].stage).toBe('dispatch_unknown');
    expect(uncertain.world?.shipments).toHaveLength(1);
    await call('/plans', { strategy: 'optimized' }, 409);
    const done = await call(`/plans/${p.id}/recover`, {});
    expect(from(done, p).status).toBe('completed');
    expect(done.world?.shipments).toHaveLength(3);
    expect(done.events.filter((e) => e.kind === 'carrier.reconciled')).toHaveLength(1);
  });
  it('holds reservations while reconciliation is unavailable, then recovers when lookup returns', async () => {
    const p = await approved();
    await call('/demo/fault', { fault: 'lost_response' });
    await call(`/plans/${p.id}/execute`, {});
    await call('/demo/fault', { fault: 'lookup_unavailable' });
    const held = await call(`/plans/${p.id}/recover`, {});
    expect(from(held, p).status).toBe('uncertain');
    expect(held.world?.shipments).toHaveLength(1);
    expect(held.world?.reservations[0].status).toBe('held');
    await call('/plans', { strategy: 'greedy' }, 409);
    await call('/demo/fault', { fault: 'clear' });
    const done = await call(`/plans/${p.id}/recover`, {});
    expect(from(done, p).status).toBe('completed');
    expect(done.world?.shipments).toHaveLength(3);
  });
  it('holds stock after a timed-out dispatch even when later lookups return 404 and the deadline expires', async () => {
    const p = await approved();
    const action = p.actions[0];
    const blocker = await carrierDb.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `shipment:${action.id}`,
      ]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const execution = call(`/plans/${p.id}/execute`, {});
      // Observe the actual blocked provider transaction instead of relying on a sleep.
      await expect
        .poll(
          async () =>
            (
              await carrierDb.query(
                `
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
        ) AS waiting`,
                [blockerPid],
              )
            ).rows[0].waiting,
        )
        .toBe(true);
      const timedOut = await execution;
      expect(from(timedOut, p).status).toBe('uncertain');
      expect(from(timedOut, p).actions[0].stage).toBe('dispatch_unknown');
      expect(timedOut.world?.shipments).toHaveLength(0);
      expect(timedOut.world?.reservations[0].status).toBe('held');
      await db.query(
        "UPDATE scenario_state SET created_at=now()-interval '24 hours' WHERE workspace_id='00000000-0000-4000-8000-000000000001'",
      );

      // A provider outage must not erase the durable fact that dispatch was attempted.
      await call('/demo/fault', { fault: 'lookup_unavailable' });
      for (let attempt = 0; attempt < 2; attempt++) {
        const unavailable = await call(`/plans/${p.id}/recover`, {});
        expect(from(unavailable, p).status).toBe('uncertain');
        expect(from(unavailable, p).actions[0].stage).toBe('dispatch_unknown');
        expect(unavailable.world?.reservations[0].status).toBe('held');
      }
      await call('/demo/fault', { fault: 'clear' });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(
          `${carrierUrl}/shipments/${encodeURIComponent(action.id)}?scenarioId=${p.scenarioId}`,
        );
        expect(response.status).toBe(404);
        const absentNow = await call(`/plans/${p.id}/recover`, {});
        expect(from(absentNow, p).status).toBe('uncertain');
        expect(from(absentNow, p).actions[0].stage).toBe('dispatch_unknown');
        expect(from(absentNow, p).actions[0].error).toContain('may still commit');
        expect(absentNow.world?.reservations[0].status).toBe('held');
        expect(absentNow.world?.shipments).toHaveLength(0);
        const initial = p.snapshot.stock.find(
          (row) =>
            row.warehouse === action.allocation.warehouse && row.part === action.allocation.part,
        )!;
        const actual = absentNow.world?.stock.find(
          (row) => row.warehouse === initial.warehouse && row.part === initial.part,
        );
        expect(actual?.available).toBe(initial.available - action.allocation.quantity);
        await call('/plans', { strategy: 'optimized' }, 409);
      }

      // The original HTTP request is still alive inside the independently stateful carrier.
      await blocker.query('COMMIT');
      await expect
        .poll(
          async () =>
            (
              await fetch(
                `${carrierUrl}/shipments/${encodeURIComponent(action.id)}?scenarioId=${p.scenarioId}`,
              )
            ).status,
        )
        .toBe(200);
      const reconciled = await call(`/plans/${p.id}/recover`, {});
      expect(from(reconciled, p).actions[0].stage).toBe('completed');
      expect(from(reconciled, p).actions[1].stage).toBe('blocked');
      expect(from(reconciled, p).status).toBe('needs_replan');
      expect(reconciled.world?.shipments).toHaveLength(1);
      expect(reconciled.world?.reservations).toHaveLength(1);
      expect(reconciled.world?.reservations[0].status).toBe('consumed');
      expect(reconciled.events.filter((event) => event.kind === 'carrier.reconciled')).toHaveLength(
        1,
      );
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('releases expired inventory only when dispatch was never attempted', async () => {
    const p = await approved();
    await call('/demo/fault', { fault: 'lookup_unavailable' });
    const held = await call(`/plans/${p.id}/execute`, {});
    expect(from(held, p).status).toBe('uncertain');
    expect(from(held, p).actions[0].stage).toBe('reserved');
    expect(held.world?.reservations[0].status).toBe('held');
    expect(held.events.some((event) => event.kind === 'action.dispatching')).toBe(false);
    await db.query(
      "UPDATE scenario_state SET created_at=now()-interval '24 hours' WHERE workspace_id='00000000-0000-4000-8000-000000000001'",
    );
    await call('/demo/fault', { fault: 'clear' });
    const expired = await call(`/plans/${p.id}/recover`, {});
    expect(from(expired, p).status).toBe('needs_replan');
    expect(from(expired, p).actions[0].stage).toBe('blocked');
    expect(expired.world?.shipments).toHaveLength(0);
    expect(expired.world?.reservations[0].status).toBe('released');
    const allocation = p.actions[0].allocation;
    const initial = p.snapshot.stock.find(
      (row) => row.warehouse === allocation.warehouse && row.part === allocation.part,
    )!;
    const actual = expired.world?.stock.find(
      (row) => row.warehouse === initial.warehouse && row.part === initial.part,
    );
    expect(actual).toEqual({ ...initial, version: initial.version + 2 });
    expect(expired.events.some((event) => event.kind === 'action.dispatching')).toBe(false);
  });
  it('reconciles a timed-out reservation that commits after its repair deadline before allowing replacement', async () => {
    const p = await approved();
    const action = p.actions[0];
    const blocker = await inventoryDb.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `reservation:${action.id}`,
      ]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const execution = call(`/plans/${p.id}/execute`, {});
      await expect
        .poll(
          async () =>
            (
              await inventoryDb.query(
                `
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
        ) AS waiting`,
                [blockerPid],
              )
            ).rows[0].waiting,
        )
        .toBe(true);
      const timedOut = await execution;
      expect(from(timedOut, p).status).toBe('uncertain');
      expect(from(timedOut, p).actions[0].stage).toBe('reserving');
      expect(timedOut.world?.reservations).toHaveLength(0);
      await db.query(
        "UPDATE scenario_state SET created_at=now()-interval '24 hours' WHERE workspace_id='00000000-0000-4000-8000-000000000001'",
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          (await fetch(`${inventoryUrl}/reservations/${encodeURIComponent(action.id)}`)).status,
        ).toBe(404);
        const pending = await call(`/plans/${p.id}/recover`, {});
        expect(from(pending, p).status).toBe('uncertain');
        expect(from(pending, p).actions[0].stage).toBe('reserving');
        expect(from(pending, p).actions[0].error).toContain('reservation may still commit');
        expect(pending.world?.reservations).toHaveLength(0);
        expect(pending.world?.shipments).toHaveLength(0);
        await call('/plans', { strategy: 'optimized' }, 409);
      }

      await blocker.query('COMMIT');
      await expect
        .poll(
          async () =>
            (await fetch(`${inventoryUrl}/reservations/${encodeURIComponent(action.id)}`)).status,
        )
        .toBe(200);
      const reconciled = await call(`/plans/${p.id}/recover`, {});
      expect(from(reconciled, p).status).toBe('needs_replan');
      expect(from(reconciled, p).actions[0].stage).toBe('blocked');
      expect(reconciled.world?.reservations).toHaveLength(1);
      expect(reconciled.world?.reservations[0].status).toBe('released');
      expect(reconciled.world?.shipments).toHaveLength(0);
      const initial = p.snapshot.stock.find(
        (row) =>
          row.warehouse === action.allocation.warehouse && row.part === action.allocation.part,
      )!;
      const actual = reconciled.world?.stock.find(
        (row) => row.warehouse === initial.warehouse && row.part === initial.part,
      );
      expect(actual).toEqual({ ...initial, version: initial.version + 2 });
      expect(reconciled.events.some((event) => event.kind === 'action.dispatching')).toBe(false);
      await call('/observe', {});
      const next = await proposal();
      expect(next.status).toBe('proposed');
      expect(next.id).not.toBe(p.id);
      expect(next.actions).toHaveLength(0); // Expired orders are honestly reported as unfilled.
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  it('restarts a real process after dispatch before recording its response, and reconciles durable intent', async () => {
    const p = await approved();
    await call('/demo/fault', { fault: 'crash_after_dispatch' });
    const exited = once(child, 'exit');
    await expect(
      fetch(base + `/api/plans/${p.id}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ).rejects.toThrow();
    expect((await exited)[0]).toBe(86);
    await start();
    const restarted = await call('/state');
    expect(from(restarted, p).status).toBe('uncertain');
    expect(from(restarted, p).actions[0].stage).toBe('dispatching');
    expect(from(restarted, p).actions[0].shipment).toBeNull();
    expect(restarted.world?.shipments).toHaveLength(1);
    const recovered = await call(`/plans/${p.id}/recover`, {});
    expect(from(recovered, p).status).toBe('completed');
    expect(recovered.world?.shipments).toHaveLength(3);
    expect(recovered.events.some((e) => e.kind === 'carrier.reconciled')).toBe(true);
  });
  it('serializes concurrent execution requests and never double dispatches', async () => {
    const p = await approved();
    const replies = await Promise.all(
      [1, 2].map(() =>
        fetch(base + `/api/plans/${p.id}/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      ),
    );
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await call('/state')).world?.shipments).toHaveLength(3);
  });
  it('invalidates a plan when its actual repair window has expired', async () => {
    const p = await approved();
    await db.query(
      "UPDATE scenario_state SET created_at=now()-interval '24 hours' WHERE workspace_id='00000000-0000-4000-8000-000000000001'",
    );
    const s = await call(`/plans/${p.id}/execute`, {});
    expect(from(s, p).status).toBe('needs_replan');
    expect(s.world?.shipments).toHaveLength(0);
    expect(s.world?.reservations).toHaveLength(0);
  });
  it('rejects expired proposal approvals and modified approved plan content', async () => {
    const p = await proposal();
    await db.query(
      "UPDATE plans SET snapshot=jsonb_set(snapshot,'{observedAt}',to_jsonb((now()-interval '11 minutes')::text)) WHERE id=$1",
      [p.id],
    );
    await call(`/plans/${p.id}/approve`, { hash: p.hash }, 409);
    await call('/demo/reset', {});
    const current = await approved();
    await db.query("UPDATE plans SET solution=jsonb_set(solution,'{totalCost}','0') WHERE id=$1", [
      current.id,
    ]);
    await call(`/plans/${current.id}/execute`, {}, 409);
    expect((await call('/state')).world?.shipments).toHaveLength(0);
  });
  it('retains audit and provider truth when starting a new independent demo epoch', async () => {
    const p = await approved();
    const done = await call(`/plans/${p.id}/execute`, {});
    const fresh = await call('/demo/reset', {});
    expect(fresh.scenario.id).not.toBe(done.scenario.id);
    expect(fresh.world?.shipments).toHaveLength(0);
    const old = await fetch(`${carrierUrl}/scenarios/${done.scenario.id}`).then((r) => r.json());
    expect(old.shipments).toHaveLength(3);
    expect(
      Number(
        (await db.query('SELECT count(*) FROM events WHERE scenario_id=$1', [done.scenario.id]))
          .rows[0].count,
      ),
    ).toBeGreaterThan(0);
    await call(`/plans/${p.id}/execute`, {}, 409);
  });
});

describe('operator cancellation against terminal provider receipts', () => {
  const reason = 'Repair work was rescheduled by the operator.';

  async function tombstones(plan: Plan) {
    return {
      carrier: (
        await carrierDb.query(
          'SELECT key FROM carrier_cancellations WHERE scenario_id=$1 ORDER BY key',
          [plan.scenarioId],
        )
      ).rows.map((row: { key: string }) => row.key),
      inventory: (
        await inventoryDb.query(
          'SELECT key FROM inventory_cancellations WHERE scenario_id=$1 ORDER BY key',
          [plan.scenarioId],
        )
      ).rows.map((row: { key: string }) => row.key),
    };
  }

  it('cancels an approved plan before execution, permanently fences every key, and requires new approval', async () => {
    const plan = await approved();
    const cancelled = await call(`/plans/${plan.id}/cancel`, { reason });
    expect(from(cancelled, plan).status).toBe('needs_replan');
    expect(from(cancelled, plan).cancelReason).toBe(reason);
    expect(from(cancelled, plan).actions.every((action) => action.stage === 'blocked')).toBe(true);
    expect(cancelled.world?.shipments).toEqual([]);
    expect(cancelled.world?.reservations).toEqual([]);
    expect(cancelled.world?.stock).toEqual(
      [...plan.snapshot.stock].sort(
        (left, right) =>
          left.warehouse.localeCompare(right.warehouse) || left.part.localeCompare(right.part),
      ),
    );
    const keys = plan.actions.map((action) => action.id).sort();
    expect(await tombstones(plan)).toEqual({ carrier: keys, inventory: keys });
    expect(verifyEvidence(await call('/audit')).valid).toBe(true);
    // A second cancellation preserves the original reason and does not repeat intent.
    const again = await call(`/plans/${plan.id}/cancel`, {
      reason: 'A second click must not rewrite the original intent.',
    });
    expect(from(again, plan).cancelReason).toBe(reason);
    expect(
      again.events.filter((event) => event.kind === 'plan.cancellation_requested'),
    ).toHaveLength(1);
    const replacement = await proposal();
    expect(replacement.actions).toHaveLength(plan.actions.length);
    await call(`/plans/${replacement.id}/execute`, {}, 409);
    await call(`/plans/${replacement.id}/approve`, { hash: replacement.hash });
    const completed = await call(`/plans/${replacement.id}/execute`, {});
    expect(from(completed, replacement).status).toBe('completed');
    expect(completed.world?.shipments).toHaveLength(3);
  });

  it('retains a completed transfer and consumed inventory while cancelling only remaining work', async () => {
    const plan = await approved();
    const partial = await call(`/plans/${plan.id}/step`, {});
    const completedAction = from(partial, plan).actions.find(
      (action) => action.stage === 'completed',
    )!;
    const committedShipment = partial.world!.shipments[0];
    const consumedReservation = partial.world!.reservations[0];
    const cancelled = await call(`/plans/${plan.id}/cancel`, { reason });
    expect(from(cancelled, plan).status).toBe('needs_replan');
    expect(
      from(cancelled, plan).actions.find((action) => action.id === completedAction.id)?.stage,
    ).toBe('completed');
    expect(cancelled.world?.shipments).toEqual([committedShipment]);
    expect(cancelled.world?.reservations).toEqual([consumedReservation]);
    const cancelledKeys = plan.actions
      .filter((action) => action.id !== completedAction.id)
      .map((action) => action.id)
      .sort();
    expect(await tombstones(plan)).toEqual({ carrier: cancelledKeys, inventory: cancelledKeys });
    expect(verifyEvidence(await call('/audit')).valid).toBe(true);
    await call('/observe', {});
    const replacement = await proposal();
    expect(replacement.actions).toHaveLength(2);
    expect(
      replacement.actions.some((action) => action.allocation.orderId === committedShipment.orderId),
    ).toBe(false);
    await call(`/plans/${replacement.id}/approve`, { hash: replacement.hash });
    const completed = await call(`/plans/${replacement.id}/execute`, {});
    expect(from(completed, replacement).status).toBe('completed');
    expect(completed.world?.shipments).toHaveLength(3);
    expect(new Set(completed.world?.shipments.map((shipment) => shipment.orderId)).size).toBe(3);
    expect(
      completed.world?.shipments.find((shipment) => shipment.key === committedShipment.key),
    ).toEqual(committedShipment);
    expect(
      completed.world?.reservations.every((reservation) => reservation.status === 'consumed'),
    ).toBe(true);
  });

  it('reconciles an accepted shipment after a lost dispatch response while terminally cancelling the remainder', async () => {
    const plan = await approved();
    await call('/demo/fault', { fault: 'lost_response' });
    const uncertain = await call(`/plans/${plan.id}/execute`, {});
    const committed = uncertain.world!.shipments[0];
    expect(from(uncertain, plan).actions[0].stage).toBe('dispatch_unknown');
    expect(uncertain.world?.reservations[0].status).toBe('held');
    const cancelled = await call(`/plans/${plan.id}/cancel`, { reason });
    expect(from(cancelled, plan).status).toBe('needs_replan');
    expect(cancelled.world?.shipments).toEqual([committed]);
    expect(from(cancelled, plan).actions[0]).toMatchObject({
      stage: 'completed',
      shipment: committed,
      reservation: { status: 'consumed' },
    });
    expect(cancelled.world?.reservations).toHaveLength(1);
    expect(cancelled.world?.reservations[0].status).toBe('consumed');
    const expected = plan.actions
      .slice(1)
      .map((action) => action.id)
      .sort();
    expect(await tombstones(plan)).toEqual({ carrier: expected, inventory: expected });
    expect(verifyEvidence(await call('/audit')).valid).toBe(true);
    const recovered = await call(`/plans/${plan.id}/recover`, {});
    expect(recovered.world?.shipments).toEqual([committed]);
    expect(recovered.events.filter((event) => event.kind === 'action.dispatching')).toHaveLength(1);
  });

  it('keeps stock held and blocks replacements during carrier downtime, then resumes cancellation on recovery', async () => {
    const plan = await approved();
    await call('/demo/fault', { fault: 'lookup_unavailable' });
    const held = await call(`/plans/${plan.id}/execute`, {});
    expect(from(held, plan).actions[0].stage).toBe('reserved');
    expect(held.world?.reservations[0].status).toBe('held');
    const address = new URL(carrierUrl);
    await carrier.close();
    let restarted = false;
    try {
      const pending = await call(`/plans/${plan.id}/cancel`, { reason });
      expect(from(pending, plan).status).toBe('uncertain');
      expect(from(pending, plan).cancelReason).toBe(reason);
      const stockStillHeld = await fetch(`${inventoryUrl}/scenarios/${plan.scenarioId}`).then(
        (response) => response.json(),
      );
      expect(stockStillHeld.reservations[0].status).toBe('held');
      expect(stockStillHeld.stock).toEqual(held.world!.stock);
      expect(await tombstones(plan)).toEqual({ carrier: [], inventory: [] });
      await call('/plans', { strategy: 'optimized' }, 409);
      carrier = await createCarrier(carrierDatabase);
      await carrier.listen({ host: address.hostname, port: Number(address.port) });
      restarted = true;
      const cancelled = await call(`/plans/${plan.id}/recover`, {});
      expect(from(cancelled, plan).status).toBe('needs_replan');
      expect(cancelled.world?.shipments).toEqual([]);
      expect(cancelled.world?.reservations[0].status).toBe('released');
      const restored = cancelled.world!.stock.find(
        (stock) =>
          stock.warehouse === plan.actions[0].allocation.warehouse &&
          stock.part === plan.actions[0].allocation.part,
      )!;
      const initial = plan.snapshot.stock.find(
        (stock) => stock.warehouse === restored.warehouse && stock.part === restored.part,
      )!;
      expect(restored).toEqual({ ...initial, version: initial.version + 2 });
      const keys = plan.actions.map((action) => action.id).sort();
      expect(await tombstones(plan)).toEqual({ carrier: keys, inventory: keys });
      expect(cancelled.events.some((event) => event.kind === 'action.dispatching')).toBe(false);
      await call('/observe', {});
      expect((await proposal()).status).toBe('proposed');
    } finally {
      if (!restarted) {
        carrier = await createCarrier(carrierDatabase);
        await carrier.listen({ host: address.hostname, port: Number(address.port) });
      }
    }
  });

  it('finishes as completed when the final unknown dispatch had already committed', async () => {
    const plan = await approved();
    await call(`/plans/${plan.id}/step`, {});
    await call(`/plans/${plan.id}/step`, {});
    await call('/demo/fault', { fault: 'lost_response' });
    const uncertain = await call(`/plans/${plan.id}/execute`, {});
    expect(from(uncertain, plan).status).toBe('uncertain');
    expect(uncertain.world?.shipments).toHaveLength(plan.actions.length);
    const cancelled = await call(`/plans/${plan.id}/cancel`, { reason });
    expect(from(cancelled, plan).status).toBe('completed');
    expect(from(cancelled, plan).actions.every((action) => action.stage === 'completed')).toBe(
      true,
    );
    expect(cancelled.world?.shipments).toEqual(uncertain.world?.shipments);
    expect(
      cancelled.world?.reservations.every((reservation) => reservation.status === 'consumed'),
    ).toBe(true);
    expect(await tombstones(plan)).toEqual({ carrier: [], inventory: [] });
    expect(verifyEvidence(await call('/audit')).valid).toBe(true);
  });

  it('persists cancellation intent through a real process kill and makes execute resume cancellation instead of dispatch', async () => {
    const plan = await approved();
    const action = plan.actions[0];
    const blocker = await carrierDb.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `shipment:${action.id}`,
      ]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = fetch(`${base}/api/plans/${plan.id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const interrupted = expect(pending).rejects.toThrow();
      await expect
        .poll(
          async () =>
            (
              await carrierDb.query(
                `
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS waiting`,
                [blockerPid],
              )
            ).rows[0].waiting,
        )
        .toBe(true);
      expect(
        (await db.query('SELECT cancel_reason,status FROM plans WHERE id=$1', [plan.id])).rows[0],
      ).toEqual({ cancel_reason: reason, status: 'uncertain' });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      expect((await exited)[1]).toBe('SIGKILL');
      await interrupted;
      await start();
      const restarted = await call('/state');
      expect(from(restarted, plan)).toMatchObject({ status: 'uncertain', cancelReason: reason });
      expect(restarted.world?.shipments).toEqual([]);
      await call('/plans', { strategy: 'optimized' }, 409);
      // The old provider request may still complete after its app process died.
      await blocker.query('COMMIT');
      await expect
        .poll(
          async () =>
            (
              await carrierDb.query(
                'SELECT count(*)::int AS count FROM carrier_cancellations WHERE key=$1',
                [action.id],
              )
            ).rows[0].count,
        )
        .toBe(1);
      const resumed = await call(`/plans/${plan.id}/execute`, {});
      expect(from(resumed, plan)).toMatchObject({ status: 'needs_replan', cancelReason: reason });
      expect(resumed.world?.shipments).toEqual([]);
      expect(resumed.world?.reservations).toEqual([]);
      expect(resumed.events.some((event) => event.kind === 'action.dispatching')).toBe(false);
      expect(
        resumed.events.filter((event) => event.kind === 'plan.cancellation_requested'),
      ).toHaveLength(1);
      const keys = plan.actions.map((item) => item.id).sort();
      expect(await tombstones(plan)).toEqual({ carrier: keys, inventory: keys });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (child.exitCode !== null || child.signalCode !== null) await start();
    }
  });
});
