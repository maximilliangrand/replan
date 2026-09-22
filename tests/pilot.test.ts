import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppState } from '../shared/contracts.js';
import { provisionOperator, type Principal } from '../src/auth.js';
import { makeScenario } from '../src/scenario.js';
import { verifyEvidence } from '../src/replay.js';
import { createInventory } from '../src/simulators/inventory.js';
import { createCarrier } from '../src/simulators/carrier.js';

const databaseUrl =
  process.env.TEST_PILOT_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_pilot_test';
const inventoryDatabase =
  process.env.TEST_INVENTORY_DATABASE_URL ??
  'postgres://replan@127.0.0.1:55432/replan_inventory_test';
const carrierDatabase =
  process.env.TEST_CARRIER_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_carrier_test';
for (const url of [databaseUrl, inventoryDatabase, carrierDatabase]) {
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Pilot integration tests require dedicated *_test databases.');
}
const db = new pg.Pool({ connectionString: databaseUrl });
const runtimeRole = `pilot_runtime_${randomBytes(8).toString('hex')}`;
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.searchParams.set(
  'options',
  `${runtimeUrl.searchParams.get('options') ?? ''} -c role=${runtimeRole}`.trim(),
);
let runtimeDb: pg.Pool | undefined;
let runtimeRoleCreated = false;
let restorePublicCreate = false;
const token = randomBytes(32).toString('hex');
const origin = 'https://pilot.example';
type Actor = { principal: Principal; key: string };
type Dataset = ReturnType<typeof makeScenario>;
let adminA: Actor;
let operatorA: Actor;
let viewerA: Actor;
let adminB: Actor;
let datasetA: Dataset;
let datasetB: Dataset;
let inventory: FastifyInstance;
let carrier: FastifyInstance;
let inventoryUrl: string;
let carrierUrl: string;
let child: ChildProcess;
let base: string;
let logs = '';

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function raw(
  path: string,
  actor?: Actor,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  // Node's native fetch may replace Host. Model the TLS ingress explicitly,
  // retaining the configured public host while connecting to the loopback app.
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      `${base}/api${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: 'pilot.example',
          'content-type': 'application/json',
          ...(actor ? { authorization: `Bearer ${actor.key}` } : {}),
          ...(body === undefined ? {} : { origin }),
          ...headers,
        },
        signal: AbortSignal.timeout(15_000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
              resultHeaders.append(name, item);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: resultHeaders,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function call<T = AppState>(
  path: string,
  actor?: Actor,
  body?: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await raw(path, actor, body, headers);
  const result: unknown = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return result as T;
}
async function seed(dataset: Dataset, workspaceId: string) {
  await db.query(
    'INSERT INTO operation_sources(scenario_id,workspace_id,source) VALUES($1,$2,$3)',
    [dataset.scenario.id, workspaceId, 'Pilot integration fixture'],
  );
  for (const [url, body] of [
    [inventoryUrl, { scenarioId: dataset.scenario.id, stock: dataset.stock }],
    [carrierUrl, { scenarioId: dataset.scenario.id }],
  ] as const) {
    const response = await fetch(`${url}/scenarios`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status, await response.text()).toBe(201);
  }
}
async function importOperation(actor: Actor, dataset: Dataset) {
  return call('/operations', actor, { scenario: dataset.scenario });
}
async function start(connectionString = databaseUrl, migrateOnStart = true) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      REPLAN_MODE: 'pilot',
      APP_ORIGIN: origin,
      PROVIDER_TOKEN: token,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: connectionString,
      MIGRATE_ON_START: String(migrateOnStart),
      INVENTORY_URL: inventoryUrl,
      CARRIER_URL: carrierUrl,
      PROVIDER_TIMEOUT_MS: '1000',
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
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await raw('/health')).ok) return;
    } catch {
      /* startup */
    }
    if (child.exitCode !== null) throw new Error(`Pilot process exited ${child.exitCode}: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Pilot process did not become healthy: ${logs}`);
}

async function configureRuntimeRole() {
  // Exercise the deployment script itself, replacing only the documented role
  // and database names. All operational tests below run without owner grants.
  const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const database = (await db.query('SELECT current_database() AS name')).rows[0].name as string;
  restorePublicCreate = (
    await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) p
      WHERE n.nspname='public' AND p.grantee=0 AND p.privilege_type='CREATE'
    ) AS allowed
  `)
  ).rows[0].allowed;
  await db.query(
    `CREATE ROLE ${quoteIdentifier(runtimeRole)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  );
  runtimeRoleCreated = true;
  const grants = (await readFile(new URL('../deploy/runtime-grants.sql', import.meta.url), 'utf8'))
    .replaceAll(/\breplan_runtime\b/g, quoteIdentifier(runtimeRole))
    .replace(
      /GRANT CONNECT ON DATABASE replan\b/,
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)}`,
    );
  await db.query(grants);
  runtimeDb = new pg.Pool({ connectionString: runtimeUrl.toString() });
  expect((await runtimeDb.query('SELECT current_user AS name')).rows[0].name).toBe(runtimeRole);
  // Deliberately empty updates check authorization without touching existing
  // fixtures. A runtime connection must not provision or elevate identities.
  for (const statement of [
    `CREATE TABLE public.${runtimeRole}_probe (id integer)`,
    'ALTER TABLE public.operators ADD COLUMN runtime_probe integer',
    'UPDATE operators SET role=role WHERE false',
    'UPDATE operators SET key_hash=key_hash WHERE false',
    'UPDATE operators SET workspace_id=workspace_id WHERE false',
    'UPDATE operators SET disabled=disabled WHERE false',
    'UPDATE operators SET id=id WHERE false',
    'DELETE FROM operators WHERE false',
    "INSERT INTO operation_sources(scenario_id,workspace_id,source) SELECT id,id,'untrusted' FROM workspaces WHERE false",
  ])
    await expect(runtimeDb.query(statement)).rejects.toMatchObject({ code: '42501' });
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

beforeAll(async () => {
  inventory = await createInventory(inventoryDatabase, { token });
  carrier = await createCarrier(carrierDatabase, { token });
  inventoryUrl = await inventory.listen({ host: '127.0.0.1', port: 0 });
  carrierUrl = await carrier.listen({ host: '127.0.0.1', port: 0 });
  // Schema migration is an owner job; the deployed application only verifies it.
  await start();
  await stop();
  await configureRuntimeRole();
  await start(runtimeUrl.toString(), false);
});
beforeEach(async () => {
  // Every test owns fresh workspace and provider epochs. No shared data is reset.
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2),($3,$4)', [
    workspaceA,
    'Pilot A',
    workspaceB,
    'Pilot B',
  ]);
  [adminA, operatorA, viewerA, adminB] = await Promise.all([
    provisionOperator(db, { workspaceId: workspaceA, role: 'admin', name: 'Administrator A' }),
    provisionOperator(db, { workspaceId: workspaceA, role: 'operator', name: 'Operator A' }),
    provisionOperator(db, { workspaceId: workspaceA, role: 'viewer', name: 'Viewer A' }),
    provisionOperator(db, { workspaceId: workspaceB, role: 'admin', name: 'Administrator B' }),
  ]);
  datasetA = makeScenario();
  datasetB = makeScenario();
  datasetA.scenario.name = `Workspace A ${workspaceA}`;
  datasetB.scenario.name = `Workspace B ${workspaceB}`;
  await Promise.all([seed(datasetA, workspaceA), seed(datasetB, workspaceB)]);
});
afterAll(async () => {
  await stop();
  await Promise.all([inventory?.close(), carrier?.close(), runtimeDb?.end()]);
  try {
    if (runtimeRoleCreated) {
      await db.query(`DROP OWNED BY "${runtimeRole}"`);
      await db.query(`DROP ROLE "${runtimeRole}"`);
    }
    if (restorePublicCreate) await db.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
  } finally {
    await db.end();
  }
});

describe('private pilot HTTP boundary', () => {
  it('requires identity and leaves a new workspace empty until an administrator imports its assigned operation', async () => {
    await call('/state', undefined, undefined, 401);
    const session = await call<{ mode: string; principal: null }>('/session');
    expect(session).toEqual({ mode: 'pilot', principal: null });
    const empty = await call<{ error: string }>('/state', operatorA, undefined, 503);
    expect(empty.error).toContain('no active operation');
    await call('/operations', operatorA, { scenario: datasetA.scenario }, 403);
    await call('/operations', viewerA, { scenario: datasetA.scenario }, 403);
    const imported = await importOperation(adminA, datasetA);
    expect(imported.scenario.id).toBe(datasetA.scenario.id);
    expect(imported.snapshot.stock).toEqual(expect.arrayContaining(datasetA.stock));
    expect(imported.runtime).toEqual({
      mode: 'pilot',
      demoControls: false,
      workspaceId: adminA.principal.workspaceId,
    });
    expect(imported.world).toBeNull();
  });

  it('issues a secure browser session, rejects cross-origin login and revokes it on logout', async () => {
    const response = await raw('/auth/login', undefined, { key: operatorA.key });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('__Host-replan_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    const browserHeaders = { cookie: cookie.split(';')[0] };
    const session = await call<{ principal: Principal }>(
      '/session',
      undefined,
      undefined,
      200,
      browserHeaders,
    );
    expect(session.principal).toEqual(operatorA.principal);
    await call('/auth/login', undefined, { key: operatorA.key }, 403, {
      origin: 'https://untrusted.example',
    });
    await call('/auth/logout', undefined, {}, 200, browserHeaders);
    await call('/state', undefined, undefined, 401, browserHeaders);
  });

  it('rejects foreign or unassigned provider datasets before reading their data and refuses imported-operation rewrites', async () => {
    await call('/operations', adminA, { scenario: datasetB.scenario }, 409);
    // No provider has this UUID: checking providers before ownership would fail
    // with a different error and could turn import into a cross-workspace oracle.
    await call('/operations', adminA, { scenario: makeScenario().scenario }, 409);
    await importOperation(adminA, datasetA);
    await call(
      '/operations',
      adminA,
      {
        scenario: { ...datasetA.scenario, name: 'Attempted rewrite of original evidence' },
      },
      409,
    );
    const unchanged = await call('/state', operatorA);
    expect(unchanged.scenario).toEqual(datasetA.scenario);
    expect(unchanged.events.filter((event) => event.kind === 'scenario.started')).toHaveLength(1);
  });

  it('does not replace an operation while an approved commitment remains unresolved', async () => {
    await importOperation(adminA, datasetA);
    const plan = (await call('/plans', operatorA, { strategy: 'greedy' })).plans[0];
    await call(`/plans/${plan.id}/approve`, operatorA, { hash: plan.hash });
    const next = makeScenario();
    await seed(next, adminA.principal.workspaceId);
    await call('/operations', adminA, { scenario: next.scenario }, 409);
    const current = await call('/state', operatorA);
    expect(current.scenario.id).toBe(datasetA.scenario.id);
    expect(current.plans[0].status).toBe('approved');
  });

  it('rejects an otherwise assigned dataset that already has an external shipment', async () => {
    const shipment = await fetch(`${carrierUrl}/shipments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        key: randomUUID(),
        scenarioId: datasetA.scenario.id,
        orderId: datasetA.scenario.orders[0].id,
        warehouse: 'Vienna',
        quantity: 4,
        laneId: 'VIE-LNZ',
        cost: 180,
      }),
    });
    expect(shipment.status, await shipment.text()).toBe(201);
    await call('/operations', adminA, { scenario: datasetA.scenario }, 409);
    await call('/state', operatorA, undefined, 503);
  });

  it('enforces viewer permissions and hides simulator endpoints even from administrators', async () => {
    await importOperation(adminA, datasetA);
    const planned = await call('/plans', operatorA, { strategy: 'greedy' });
    const plan = planned.plans[0];
    for (const [path, body] of [
      ['/observe', {}],
      ['/plans', { strategy: 'greedy' }],
      [`/plans/${plan.id}/approve`, { hash: plan.hash }],
      [`/plans/${plan.id}/step`, {}],
      [`/plans/${plan.id}/execute`, {}],
      [`/plans/${plan.id}/recover`, {}],
      [`/plans/${plan.id}/cancel`, { reason: 'Test viewer must not cancel' }],
    ] as const)
      await call(path, viewerA, body, 403);
    await call('/demo/reset', adminA, {}, 404);
    await call('/demo/consume', adminA, { warehouse: 'Vienna', part: 'BRG-42', quantity: 1 }, 404);
    await call('/demo/fault', adminA, { fault: 'clear' }, 404);
    const visible = await call('/state', viewerA);
    expect(visible.plans[0].status).toBe('proposed');
    expect(visible.world).toBeNull();
    expect((await call('/audit', viewerA)).scenario.id).toBe(datasetA.scenario.id);
  });

  it('attributes approval and audit evidence to the authenticated operator', async () => {
    await importOperation(adminA, datasetA);
    const plan = (await call('/plans', operatorA, { strategy: 'greedy' })).plans[0];
    const approved = await call(`/plans/${plan.id}/approve`, operatorA, { hash: plan.hash });
    expect(approved.plans[0].status).toBe('approved');
    const approval = (
      await db.query('SELECT actor,actor_id FROM approvals WHERE plan_id=$1', [plan.id])
    ).rows[0];
    expect(approval).toEqual({ actor: operatorA.principal.name, actor_id: operatorA.principal.id });
    const events = approved.events.filter(
      (event) => event.planId === plan.id && event.kind.includes('approv'),
    );
    expect(events).not.toHaveLength(0);
    for (const event of events) expect(event.data.actor).toEqual(operatorA.principal);
  });

  it('executes an approved pilot transfer end to end without duplicate commitments and exports verifiable evidence', async () => {
    await importOperation(adminA, datasetA);
    const plan = (await call('/plans', operatorA, { strategy: 'optimized' })).plans[0];
    await call(`/plans/${plan.id}/approve`, operatorA, { hash: plan.hash });
    const completed = await call(`/plans/${plan.id}/execute`, operatorA, {});
    expect(completed.plans[0].status).toBe('completed');
    expect(completed.plans[0].actions.every((action) => action.stage === 'completed')).toBe(true);
    expect(completed.world).toBeNull();
    await call(`/plans/${plan.id}/execute`, operatorA, {});
    await call(`/plans/${plan.id}/recover`, operatorA, {});
    const external = await fetch(`${carrierUrl}/scenarios/${datasetA.scenario.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(external.status).toBe(200);
    expect((await external.json()).shipments).toHaveLength(datasetA.scenario.orders.length);
    const evidence = await call('/audit', viewerA);
    expect(verifyEvidence(evidence)).toMatchObject({ valid: true });
  });

  it('records an operator cancellation without dispatching and requires a fresh approved plan to continue', async () => {
    await importOperation(adminA, datasetA);
    const plan = (await call('/plans', operatorA, { strategy: 'greedy' })).plans[0];
    await call(`/plans/${plan.id}/approve`, operatorA, { hash: plan.hash });
    await call(`/plans/${plan.id}/cancel`, operatorA, { reason: 'too short' }, 400);
    const cancelled = await call(`/plans/${plan.id}/cancel`, operatorA, {
      reason: 'Repair assignment has changed.',
    });
    expect(cancelled.plans[0].status).toBe('needs_replan');
    expect(cancelled.plans[0].cancelReason).toBe('Repair assignment has changed.');
    expect(cancelled.plans[0].actions.every((action) => action.shipment === null)).toBe(true);
    await call(`/plans/${plan.id}/execute`, operatorA, {});
    const evidence = await call('/audit', viewerA);
    expect(evidence.world?.shipments).toHaveLength(0);
    expect(
      evidence.world?.reservations.filter((reservation) => reservation.status === 'held'),
    ).toHaveLength(0);
    expect(verifyEvidence(evidence)).toMatchObject({ valid: true });
    const next = (await call('/plans', operatorA, { strategy: 'greedy' })).plans.find(
      (candidate) => candidate.id !== plan.id,
    )!;
    expect(next.status).toBe('proposed');
    await call(`/plans/${next.id}/execute`, operatorA, {}, 409);
    await call(`/plans/${next.id}/approve`, operatorA, { hash: next.hash });
    const done = await call(`/plans/${next.id}/execute`, operatorA, {});
    expect(done.plans.find((candidate) => candidate.id === next.id)?.status).toBe('completed');
  });

  it('ignores spoofed workspace headers and cannot read or mutate another workspace plan or audit', async () => {
    await Promise.all([importOperation(adminA, datasetA), importOperation(adminB, datasetB)]);
    const planA = (await call('/plans', operatorA, { strategy: 'greedy' })).plans[0];
    const planB = (await call('/plans', adminB, { strategy: 'greedy' })).plans[0];
    const spoofed = {
      'x-workspace-id': adminB.principal.workspaceId,
      'x-tenant-id': adminB.principal.workspaceId,
    };
    const scoped = await call('/state', operatorA, undefined, 200, spoofed);
    expect(scoped.scenario.id).toBe(datasetA.scenario.id);
    expect(scoped.plans.map((plan) => plan.id)).toEqual([planA.id]);
    expect(
      scoped.events.every(
        (event) =>
          event.data.actor &&
          (event.data.actor as Principal).workspaceId === operatorA.principal.workspaceId,
      ),
    ).toBe(true);
    for (const operation of ['step', 'execute', 'recover', 'approve', 'cancel']) {
      const body =
        operation === 'approve'
          ? { hash: planB.hash }
          : operation === 'cancel'
            ? { reason: 'Unauthorized cross-workspace cancellation' }
            : {};
      await call(`/plans/${planB.id}/${operation}`, operatorA, body, 409, spoofed);
    }
    const exported = await call('/audit', operatorA, undefined, 200, spoofed);
    expect(exported.scenario.id).toBe(datasetA.scenario.id);
    expect(JSON.stringify(exported)).not.toContain(planB.id);
    expect(JSON.stringify(exported)).not.toContain(datasetB.scenario.id);
    expect((await call('/state', adminB)).plans[0].status).toBe('proposed');
  });

  it('does not let a held workspace lock stall another workspace', async () => {
    await Promise.all([importOperation(adminA, datasetA), importOperation(adminB, datasetB)]);
    const lockId = (
      await db.query('SELECT lock_id FROM workspaces WHERE id=$1', [adminA.principal.workspaceId])
    ).rows[0].lock_id;
    const lock = await db.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(782019,$1)', [lockId]);
      await call('/observe', operatorA, {}, 409);
      const independent = await call('/observe', adminB, {});
      expect(independent.scenario.id).toBe(datasetB.scenario.id);
      expect(independent.events.some((event) => event.kind === 'inventory.observed')).toBe(true);
      expect((await call('/audit', adminB)).scenario.id).toBe(datasetB.scenario.id);
    } finally {
      await lock.query('SELECT pg_advisory_unlock(782019,$1)', [lockId]);
      lock.release();
    }
  });

  it('fails readiness when a provider is unavailable while retaining liveness and cached evidence', async () => {
    await importOperation(adminA, datasetA);
    await call('/ready');
    await carrier.close();
    try {
      await call('/ready', undefined, undefined, 503);
      const health = await call<{ ok: boolean }>('/health');
      expect(health.ok).toBe(true);
      expect((await call('/state', viewerA)).scenario.id).toBe(datasetA.scenario.id);
    } finally {
      carrier = await createCarrier(carrierDatabase, { token });
      await carrier.listen({ host: '127.0.0.1', port: Number(new URL(carrierUrl).port) });
    }
    await call('/ready');
  });
});
