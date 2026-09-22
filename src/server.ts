import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import type { AppState } from '../shared/contracts.js';
import { config } from './config.js';
import { audit, context, getEvents, getPlans, migrate, pool, transaction, withLock } from './db.js';
import { approve, execute, markInterrupted } from './engine.js';
import { propose } from './planner.js';
import { carrier, inventory, ProviderError, request } from './providers.js';
import { makeScenario } from './scenario.js';

const app = Fastify({
  logger: process.env.LOG_LEVEL === 'silent' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 16384,
});
const planParams = z.object({ id: z.uuid() });
const empty = z.object({}).strict();
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
app.addHook('onRequest', async (req, reply) => {
  // This is a local single-operator demo, not an authenticated shared service.
  // Host and Origin checks prevent a remote website from controlling loopback APIs.
  let host: string | undefined;
  try {
    host = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    /* rejected below */
  }
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
  reply.header('cache-control', 'no-store');
});
app.setErrorHandler((error, req, reply) => {
  if (error instanceof ZodError)
    return reply.code(400).send({ error: 'Invalid request.', issues: error.issues });
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
async function state(): Promise<AppState> {
  const { scenario, snapshot } = await context();
  const [plans, events] = await Promise.all([getPlans(scenario.id), getEvents(scenario.id)]);
  let world: AppState['world'] = null;
  let serviceWarning: string | null = null;
  try {
    // Simulator truth is diagnostic only. The planner uses the cached snapshot.
    const [i, c] = await Promise.all([inventory.state(scenario.id), carrier.state(scenario.id)]);
    world = {
      stock: i.stock,
      reservations: i.reservations,
      shipments: c.shipments,
      carrierLookupAvailable: c.lookupAvailable,
    };
  } catch {
    serviceWarning =
      'A simulator is unavailable. Cached evidence remains visible; execution will stop safely.';
  }
  return { scenario, snapshot, plans, events, world, serviceWarning };
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
      'INSERT INTO scenario_state(singleton,scenario,snapshot) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET scenario=$1,snapshot=$2,created_at=now(),crash_next=false',
      [scenario, snapshot],
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
app.get('/api/health', async () => ({ ok: true, simulation: true }));
app.get('/api/state', state);
app.get('/api/audit', async (_req, reply) => {
  reply.header('content-disposition', 'attachment; filename="replan-evidence.json"');
  return withLock(async () => ({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    ...(await state()),
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
      await db.query('UPDATE scenario_state SET snapshot=$1 WHERE singleton', [snapshot]);
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
      await db.query('UPDATE scenario_state SET crash_next=true WHERE singleton');
    else {
      await request(config.carrierUrl, `/scenarios/${scenario.id}/fault`, { fault });
      if (fault === 'clear')
        await db.query('UPDATE scenario_state SET crash_next=false WHERE singleton');
    }
    await audit(db, scenario.id, 'simulation.fault', `Simulation control: ${fault}.`, { fault });
  });
  return state();
});

if (existsSync(resolve('dist/index.html')))
  await app.register(fastifyStatic, { root: resolve('dist') });
await migrate();
await withLock(async (db) => {
  const found = await db.query('SELECT 1 FROM scenario_state');
  if (!found.rowCount) await reset(db);
  else await markInterrupted(db);
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
await app.listen({ host: config.host, port: config.port });
