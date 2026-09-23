import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { AppState } from '../shared/contracts.js';
import { config } from './config.js';
import {
  audit,
  type Connection,
  Conflict,
  context,
  getEvents,
  getPlans,
  migrate,
  verifySchema,
  pool,
  transaction,
  withLock,
  Unavailable,
} from './db.js';
import { approve, cancelPlan, execute, markInterrupted } from './engine.js';
import { propose } from './planner.js';
import { carrier, inventory, ProviderError, request } from './providers.js';
import { makeScenario } from './scenario.js';
import { registerAuth } from './auth.js';
import { asPrincipal, demoPrincipal, workspaceId } from './workspace.js';
import { operationInput } from './operations.js';
import { operationHealth } from './monitoring.js';

const app = Fastify({
  logger:
    process.env.LOG_LEVEL === 'silent'
      ? false
      : {
          level: process.env.LOG_LEVEL ?? 'info',
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            'req.body.key',
          ],
        },
  bodyLimit: 131072,
});
const planParams = z.object({ id: z.uuid() });
const empty = z.object({}).strict();
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
app.addHook('onRequest', async (req, reply) => {
  let host: string | undefined;
  try {
    host = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    /* reject below */
  }
  if (config.mode === 'pilot') {
    if (req.headers.host !== new URL(config.appOrigin!).host)
      return reply.code(403).send({ error: 'Unexpected request host.' });
  } else {
    if (!host || !allowedHosts.has(host))
      return reply.code(403).send({ error: 'This demo accepts loopback hostnames only.' });
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (!allowedHosts.has(origin.hostname) || !['http:', 'https:'].includes(origin.protocol))
          throw new Error('untrusted');
      } catch {
        return reply.code(403).send({ error: 'Cross-origin access is not allowed.' });
      }
    }
  }
  reply.header('cache-control', 'no-store');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
});
await registerAuth(app, pool, {
  mode: config.mode,
  secureCookies: config.mode === 'pilot',
  allowedOrigins: config.mode === 'pilot' ? [config.appOrigin!] : [],
  demoPrincipal,
});
// Fastify continues the handler inside this request's async context. Identity and
// workspace always come from authentication, never a request header or body.
app.addHook('preHandler', (req, _reply, done) => asPrincipal(req.principal ?? demoPrincipal, done));
app.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (path.startsWith('/api/demo/') && config.mode !== 'demo')
    return reply.code(404).send({ error: 'Not found.' });
  if (req.method !== 'POST' || path.startsWith('/api/auth/')) return;
  if (req.principal?.role === 'viewer')
    return reply
      .code(403)
      .send({ error: 'Your role can review evidence but cannot change operations.' });
  if (path === '/api/operations' && req.principal?.role !== 'admin')
    return reply.code(403).send({ error: 'An administrator must import operations.' });
});
app.setErrorHandler((error, req, reply) => {
  if (error instanceof ZodError)
    return reply.code(400).send({ error: 'Invalid request.', issues: error.issues });
  if (error instanceof Unavailable) return reply.code(503).send({ error: error.message });
  if (error instanceof ProviderError)
    return reply.code(error.status === 409 ? 409 : 503).send({ error: error.message });
  const status =
    typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number(error.statusCode)
      : 500;
  if (status >= 500) req.log.error(error);
  return reply.code(status >= 400 && status < 600 ? status : 500).send({
    error:
      status >= 500
        ? 'The operation could not finish. Refresh state; durable progress is retained.'
        : error instanceof Error
          ? error.message
          : 'Invalid request.',
  });
});
async function state(
  includeWorld = config.mode === 'demo',
  db: Connection = pool,
): Promise<AppState> {
  const { scenario, snapshot } = await context(db);
  const [plans, events] = await Promise.all([
    getPlans(scenario.id, db),
    getEvents(scenario.id, db),
  ]);
  let world: AppState['world'] = null;
  let serviceWarning: string | null = null;
  try {
    // Simulator truth is diagnostic only. The planner uses the cached snapshot.
    const [i, c] = await Promise.all([inventory.state(scenario.id), carrier.state(scenario.id)]);
    if (includeWorld)
      world = {
        stock: i.stock,
        reservations: i.reservations,
        shipments: c.shipments,
        carrierLookupAvailable: c.lookupAvailable,
      };
  } catch {
    serviceWarning =
      'A provider is unavailable. Cached evidence remains visible; unresolved execution requires reconciliation.';
  }
  return {
    scenario,
    snapshot,
    plans,
    events,
    world,
    serviceWarning,
    runtime: {
      mode: config.mode,
      demoControls: config.mode === 'demo',
      workspaceId: workspaceId(),
    },
  };
}
async function reset(db: import('pg').PoolClient) {
  const { scenario, stock } = makeScenario();
  await request(config.inventoryUrl, '/scenarios', { scenarioId: scenario.id, stock });
  await request(config.carrierUrl, '/scenarios', { scenarioId: scenario.id });
  const snapshot = { observedAt: new Date().toISOString(), stock };
  // New epochs preserve old simulator commitments and audit, including a reset
  // interrupted between providers. Only a fully seeded epoch becomes current.
  await transaction(db, async () => {
    await db.query(
      'INSERT INTO operation_sources(scenario_id,workspace_id,source) VALUES($1,$2,$3)',
      [scenario.id, workspaceId(), 'Authored synthetic demo'],
    );
    await db.query(
      'INSERT INTO scenario_state(workspace_id,scenario,snapshot) VALUES($3,$1,$2) ON CONFLICT(workspace_id) DO UPDATE SET scenario=$1,snapshot=$2,created_at=now(),crash_next=false',
      [scenario, snapshot, workspaceId()],
    );
    await audit(
      db,
      scenario.id,
      'scenario.started',
      'Synthetic supplier delay received. Repair windows are measured from this scenario start.',
      { scenario, stock },
    );
  });
}
app.get('/api/health', async () => ({ ok: true, mode: config.mode }));
app.get('/api/ready', async (_req, reply) => {
  try {
    await Promise.all([pool.query('SELECT 1'), inventory.health(), carrier.health()]);
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false, error: 'A required dependency is unavailable.' });
  }
});
app.get('/api/state', async () => state());
app.get('/api/operations/health', async () => operationHealth());
app.post('/api/operations', async (req) => {
  const { scenario } = operationInput.parse(req.body);
  await withLock(async (db) => {
    const source = (
      await db.query(
        'SELECT source FROM operation_sources WHERE scenario_id=$1 AND workspace_id=$2',
        [scenario.id, workspaceId()],
      )
    ).rows[0];
    if (!source)
      throw new Conflict('This provider dataset has not been assigned to your workspace.');
    const used = await db.query(
      'SELECT 1 FROM events WHERE scenario_id=$1 AND workspace_id=$2 LIMIT 1',
      [scenario.id, workspaceId()],
    );
    if (used.rowCount)
      throw new Conflict('An imported operation cannot be restarted or rewritten.');
    const live = await db.query(
      "SELECT 1 FROM plans WHERE workspace_id=$1 AND status IN ('approved','executing','uncertain') LIMIT 1",
      [workspaceId()],
    );
    if (live.rowCount)
      throw new Conflict('Resolve the current approved operation before importing another.');
    const [observed, dispatches] = await Promise.all([
      inventory.state(scenario.id),
      carrier.state(scenario.id),
    ]);
    if (observed.reservations.length || dispatches.shipments.length)
      throw new Conflict(
        'A new operation requires a fresh provider dataset with no prior commitments.',
      );
    const snapshot = { observedAt: new Date().toISOString(), stock: observed.stock };
    await transaction(db, async () => {
      await db.query(
        'INSERT INTO scenario_state(workspace_id,scenario,snapshot) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET scenario=$2,snapshot=$3,created_at=now(),crash_next=false',
        [workspaceId(), scenario, snapshot],
      );
      await audit(
        db,
        scenario.id,
        'scenario.started',
        'Administrator imported an operation with authoritative inventory evidence.',
        { scenario, stock: observed.stock, source: source.source },
      );
    });
  });
  return state();
});
app.get('/api/audit', async (_req, reply) => {
  reply.header('content-disposition', 'attachment; filename="replan-evidence.json"');
  return withLock(async (db) => ({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    ...(await state(true, db)),
  }));
});
app.post('/api/demo/reset', async (req) => {
  empty.parse(req.body);
  await withLock(reset);
  return state();
});
app.post('/api/observe', async (req) => {
  empty.parse(req.body);
  await withLock(async (db) => {
    const { scenario } = await context(db);
    const snapshot = {
      observedAt: new Date().toISOString(),
      stock: (await inventory.state(scenario.id)).stock,
    };
    await transaction(db, async () => {
      await db.query('UPDATE scenario_state SET snapshot=$1 WHERE workspace_id=$2', [
        snapshot,
        workspaceId(),
      ]);
      await audit(
        db,
        scenario.id,
        'inventory.observed',
        'Refreshed observed inventory. Existing proposals retain their original evidence.',
        { snapshot },
      );
    });
  });
  return state();
});
app.post('/api/plans', async (req) => {
  const { strategy } = z
    .object({ strategy: z.enum(['optimized', 'greedy']) })
    .strict()
    .parse(req.body);
  await withLock((db) => propose(db, strategy));
  return state();
});
app.post('/api/plans/:id/approve', async (req) => {
  const { id } = planParams.parse(req.params);
  const { hash } = z
    .object({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(req.body);
  await withLock((db) => approve(db, id, hash));
  return state();
});
for (const operation of ['execute', 'step', 'recover']) {
  app.post(`/api/plans/:id/${operation}`, async (req) => {
    const { id } = planParams.parse(req.params);
    empty.parse(req.body);
    await withLock((db) => execute(db, id, operation === 'step'));
    return state();
  });
}
app.post('/api/plans/:id/cancel', async (req) => {
  const { id } = planParams.parse(req.params);
  const { reason } = z
    .object({ reason: z.string().trim().min(10).max(1000) })
    .strict()
    .parse(req.body);
  await withLock((db) => cancelPlan(db, id, reason));
  return state();
});
app.post('/api/demo/consume', async (req) => {
  const body = z
    .object({
      warehouse: z.string().min(1),
      part: z.string().min(1),
      quantity: z.number().int().positive().max(10000),
    })
    .strict()
    .parse(req.body);
  await withLock(async (db) => {
    const { scenario } = await context(db);
    const evidence = await request(config.inventoryUrl, `/scenarios/${scenario.id}/consume`, body);
    await audit(
      db,
      scenario.id,
      'simulation.stock_changed',
      'Another customer consumed stock. The app has not observed this change yet.',
      { request: body, result: evidence },
    );
  });
  return state();
});
app.post('/api/demo/fault', async (req) => {
  const { fault } = z
    .object({
      fault: z.enum(['lost_response', 'crash_after_dispatch', 'lookup_unavailable', 'clear']),
    })
    .strict()
    .parse(req.body);
  await withLock(async (db) => {
    const { scenario } = await context(db);
    if (fault === 'crash_after_dispatch')
      await db.query('UPDATE scenario_state SET crash_next=true WHERE workspace_id=$1', [
        workspaceId(),
      ]);
    else {
      await request(config.carrierUrl, `/scenarios/${scenario.id}/fault`, { fault });
      if (fault === 'clear')
        await db.query('UPDATE scenario_state SET crash_next=false WHERE workspace_id=$1', [
          workspaceId(),
        ]);
    }
    await audit(db, scenario.id, 'simulation.fault', `Simulation control: ${fault}.`, { fault });
  });
  return state();
});

if (existsSync(resolve('dist/index.html')))
  await app.register(fastifyStatic, { root: resolve('dist') });
if (process.env.MIGRATE_ON_START === 'false') await verifySchema();
else await migrate();
if (config.mode === 'demo')
  await asPrincipal(demoPrincipal, () =>
    withLock(async (db) => {
      const found = await db.query('SELECT 1 FROM scenario_state WHERE workspace_id=$1', [
        workspaceId(),
      ]);
      if (!found.rowCount) await reset(db);
    }),
  );
const active = await pool.query('SELECT workspace_id FROM scenario_state');
for (const row of active.rows) {
  await asPrincipal(
    { ...demoPrincipal, name: 'Recovery supervisor', workspaceId: row.workspace_id },
    async () => {
      try {
        await withLock(markInterrupted);
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    },
  );
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
await app.listen({ host: config.host, port: config.port });
