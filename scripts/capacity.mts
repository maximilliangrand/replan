import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { provisionOperator } from '../src/auth.js';
import { createInventory } from '../src/simulators/inventory.js';
import { createCarrier } from '../src/simulators/carrier.js';
import { verifyEvidence } from '../src/replay.js';
import type { AppState, Scenario, Stock } from '../shared/contracts.js';
import type { FastifyInstance } from 'fastify';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const adminUrl = new URL(
  process.env.CAPACITY_ADMIN_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    'postgres://replan@127.0.0.1:55432/replan_test',
);
if (
  !['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
  !adminUrl.pathname.endsWith('_test')
)
  throw new Error('Capacity requires an explicitly selected *_test administration database.');
const suffix = randomBytes(8).toString('hex');
const names = ['app', 'inventory', 'carrier'].map(
  (kind) => `replan_capacity_${suffix}_${kind}_test`,
);
const role = `capacity_${suffix}`;
const created: string[] = [];
const admin = new pg.Pool({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000 });
const opened: pg.Pool[] = [];
const services: FastifyInstance[] = [];
const children = new Set<ChildProcess>();
const origin = 'https://capacity.example';
const token = randomBytes(32).toString('hex');
const clientTimeoutMs = 15_000;
let base = '';
let roleCreated = false;
const samples: {
  phase: string;
  workspace: number;
  route: string;
  status: number;
  ms: number;
  valid: boolean;
  solverStatus?: string;
  solveMs?: number;
  plannedOrders?: number;
}[] = [];
const errors: string[] = [];
const databaseUrl = (name: string) => {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url;
};
const rounded = (number: number) => Math.round(number * 100) / 100;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function child(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const process = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(process);
  process.once('close', () => children.delete(process));
  process.on('error', () => errors.push('A harness subprocess could not start.'));
  // Drain output without persisting environment, credentials, or fixture identities.
  process.stdout!.resume();
  process.stderr!.resume();
  return process;
}
async function run(command: string, args: string[], env = process.env) {
  const process = child(command, args, env);
  const timer = setTimeout(() => process.kill('SIGKILL'), 60_000);
  try {
    const [code] = await once(process, 'close');
    if (code !== 0) throw new Error('Setup subprocess failed.');
  } finally {
    clearTimeout(timer);
  }
}
async function raw(route: string, key?: string, body?: unknown) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const request = httpRequest(
      `${base}/api${route}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(clientTimeoutMs),
        headers: {
          host: 'capacity.example',
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { origin }),
        },
      },
      (response) => {
        const buffers: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4_000_000) request.destroy(new Error('Response exceeded harness limit.'));
          else buffers.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(buffers).toString()),
            });
          } catch {
            reject(new Error('Invalid JSON response.'));
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function dataset(seed: number) {
  const scenario: Scenario = {
    id: randomUUID(),
    name: `Synthetic capacity ${seed}`,
    description: 'Deterministic authored workload; not production data.',
    orders: [],
    lanes: [],
  };
  const stock: Stock[] = [];
  for (let w = 0; w < 10; w++) {
    for (let p = 0; p < 5; p++)
      stock.push({ warehouse: `W${w}`, part: `P${p}`, available: 20, version: 1 });
    for (let f = 0; f < 10; f++)
      for (let mode = 0; mode < 5; mode++)
        scenario.lanes.push({
          id: `W${w}-F${f}-M${mode}`,
          warehouse: `W${w}`,
          factory: `F${f}`,
          mode: `Mode ${mode}`,
          hours: 2 + mode,
          unitCost: 5 + ((w * 7 + f * 3 + mode * 11 + seed) % 35),
          capacity: 12,
        });
  }
  for (let i = 0; i < 100; i++)
    scenario.orders.push({
      id: `O${i}`,
      factory: `F${i % 10}`,
      part: `P${(Math.floor(i / 10) + seed) % 5}`,
      quantity: 1 + ((i + seed) % 4),
      priority: 1 + ((i * 7 + seed) % 10),
      deadlineHours: 8 + (i % 3) * 2,
    });
  return { scenario, stock };
}
type Workspace = {
  id: string;
  key: string;
  data: ReturnType<typeof dataset>;
  index: number;
  plan?: AppState['plans'][number];
};
const workspaces: Workspace[] = [];
async function sample(
  phase: string,
  workspace: Workspace,
  route: string,
  body?: unknown,
  accepted = [200],
) {
  const started = performance.now();
  let status = 0;
  let result: unknown;
  let valid = false;
  let validatedState: AppState | undefined;
  let planning: { solverStatus: string; solveMs: number; plannedOrders: number } | undefined;
  try {
    const response = await raw(route, workspace.key, body);
    status = response.status;
    result = response.body;
    valid = accepted.includes(status);
    if (status === 200) {
      const state = result as AppState;
      valid &&=
        state.scenario?.id === workspace.data.scenario.id &&
        state.runtime?.workspaceId === workspace.id;
      valid &&= state.plans.every((plan) => plan.scenarioId === workspace.data.scenario.id);
      // Every event references a plan from this response; actor context must also stay scoped.
      valid &&= state.events.every(
        (event) =>
          (!event.planId || state.plans.some((plan) => plan.id === event.planId)) &&
          (!event.data.actor ||
            (event.data.actor as { workspaceId?: string }).workspaceId === workspace.id),
      );
      if (route === '/audit') valid &&= verifyEvidence(result).valid;
      if (valid && phase === 'planning') {
        const solution = state.plans[0]?.solution;
        if (
          !solution ||
          typeof solution.solverStatus !== 'string' ||
          !Number.isFinite(solution.solveMs) ||
          solution.solveMs < 0 ||
          !Array.isArray(solution.allocations)
        )
          throw new Error('Invalid planning metadata.');
        planning = {
          solverStatus: solution.solverStatus,
          solveMs: solution.solveMs,
          plannedOrders: solution.allocations.length,
        };
      }
      if (valid) validatedState = state;
    } else valid &&= !('scenario' in (result as object)) && !('plans' in (result as object));
  } catch {
    /* Timeouts and malformed responses are retained as failed samples. */
    valid = false;
    validatedState = undefined;
    planning = undefined;
  }
  samples.push({
    phase,
    workspace: workspace.index,
    route: route.replace(/[a-f0-9-]{36}/g, ':id'),
    status,
    ms: rounded(performance.now() - started),
    valid,
    ...planning,
  });
  if (!valid)
    errors.push(`Invalid sample in ${phase}, workspace ${workspace.index}, HTTP ${status}.`);
  return validatedState;
}
let report: Record<string, unknown> = {};
try {
  const postgresVersion = (await admin.query('SHOW server_version')).rows[0]
    .server_version as string;
  for (const name of names) {
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
  }
  const appUrl = databaseUrl(names[0]);
  await run(process.execPath, ['--import', 'tsx', 'scripts/migrate.mts'], {
    ...process.env,
    DATABASE_URL: appUrl.toString(),
    REPLAN_MODE: 'demo',
    NODE_ENV: 'test',
  });
  await run('uv', [
    'run',
    '--frozen',
    '--project',
    'solver',
    'python',
    '-c',
    'from ortools.sat.python import cp_model',
  ]);
  const db = new pg.Pool({ connectionString: appUrl.toString() });
  opened.push(db);
  await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  roleCreated = true;
  const grants = (await readFile('deploy/runtime-grants.sql', 'utf8'))
    .replaceAll(/\breplan_runtime\b/g, `"${role}"`)
    .replace(/GRANT CONNECT ON DATABASE replan\b/, `GRANT CONNECT ON DATABASE "${names[0]}"`);
  await db.query(grants);
  const runtimeUrl = new URL(appUrl);
  runtimeUrl.searchParams.set(
    'options',
    `${runtimeUrl.searchParams.get('options') ?? ''} -c role=${role}`.trim(),
  );
  const runtime = new pg.Pool({ connectionString: runtimeUrl.toString() });
  opened.push(runtime);
  if ((await runtime.query('SELECT current_user AS name')).rows[0].name !== role)
    throw new Error('Runtime role was not applied.');
  const inventory = await createInventory(databaseUrl(names[1]).toString(), { token });
  services.push(inventory);
  const carrier = await createCarrier(databaseUrl(names[2]).toString(), { token });
  services.push(carrier);
  const inventoryUrl = await inventory.listen({ host: '127.0.0.1', port: 0 });
  const carrierUrl = await carrier.listen({ host: '127.0.0.1', port: 0 });
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  child(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    ...process.env,
    REPLAN_MODE: 'pilot',
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    PROVIDER_TOKEN: token,
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: runtimeUrl.toString(),
    MIGRATE_ON_START: 'false',
    INVENTORY_URL: inventoryUrl,
    CARRIER_URL: carrierUrl,
    PROVIDER_TIMEOUT_MS: '2000',
    LOG_LEVEL: 'silent',
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await raw('/ready')).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await pause(50);
  }
  if (!ready) throw new Error('Pilot did not become ready.');
  for (let index = 0; index < 4; index++) {
    const id = randomUUID();
    const data = dataset(index);
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      id,
      'Synthetic capacity workspace',
    ]);
    const actor = await provisionOperator(db, {
      workspaceId: id,
      role: 'admin',
      name: 'Synthetic capacity administrator',
    });
    await db.query(
      'INSERT INTO operation_sources(scenario_id,workspace_id,source) VALUES($1,$2,$3)',
      [data.scenario.id, id, 'Synthetic capacity harness'],
    );
    for (const [url, body] of [
      [inventoryUrl, { scenarioId: data.scenario.id, stock: data.stock }],
      [carrierUrl, { scenarioId: data.scenario.id }],
    ] as const) {
      const response = await fetch(`${url}/scenarios`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(clientTimeoutMs),
      });
      if (response.status !== 201) throw new Error('Provider fixture seeding failed.');
      await response.arrayBuffer();
    }
    workspaces.push({ id, key: actor.key, data, index });
  }
  await Promise.all(
    workspaces.map((workspace) =>
      sample('import', workspace, '/operations', { scenario: workspace.data.scenario }),
    ),
  );
  if (errors.length) throw new Error('Import acceptance failed.');
  await Promise.all(
    workspaces.map(async (workspace) => {
      const result = await sample('planning', workspace, '/plans', { strategy: 'optimized' });
      workspace.plan = result?.plans[0];
    }),
  );
  if (errors.length) throw new Error('Planning acceptance failed.');
  // One request per workspace at a time measures independent workspace concurrency.
  await Promise.all(
    workspaces.map(async (workspace) => {
      for (let i = 0; i < 20; i++)
        await sample(
          i % 2 === 0 ? 'state_reads' : 'audit_exports',
          workspace,
          i % 2 === 0 ? '/state' : '/audit',
        );
    }),
  );
  await Promise.all(
    Array.from({ length: 12 }, () =>
      sample('same_workspace_contention', workspaces[0], '/observe', {}, [200, 409]),
    ),
  );
  await Promise.all(
    workspaces.map((workspace, index) => {
      const foreign = workspaces[(index + 1) % workspaces.length].plan!;
      return sample(
        'cross_workspace_denial',
        workspace,
        `/plans/${foreign.id}/approve`,
        { hash: foreign.hash },
        [409],
      );
    }),
  );
  await Promise.all(workspaces.map((workspace) => sample('final_export', workspace, '/audit')));
  const phases: Record<string, unknown> = {};
  for (const phase of new Set(samples.map((sample) => sample.phase))) {
    const selected = samples.filter((sample) => sample.phase === phase);
    const times = selected.map((sample) => sample.ms).sort((a, b) => a - b);
    phases[phase] = {
      requests: selected.length,
      p50Ms: times[Math.ceil(times.length * 0.5) - 1],
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      maxMs: times.at(-1),
      failures: selected.filter((sample) => !sample.valid).length,
      statusCodes: Object.fromEntries(
        [...new Set(selected.map((sample) => sample.status))].map((status) => [
          status,
          selected.filter((sample) => sample.status === status).length,
        ]),
      ),
    };
  }
  const sources = [
    'scripts/capacity.mts',
    'src/server.ts',
    'src/planner.ts',
    'src/db.ts',
    'src/auth.ts',
    'src/providers.ts',
    'src/simulators/common.ts',
    'src/simulators/inventory.ts',
    'src/simulators/carrier.ts',
    'src/config.ts',
    'src/workspace.ts',
    'src/monitoring.ts',
    'deploy/runtime-grants.sql',
    'package-lock.json',
    'solver/main.py',
    'solver/uv.lock',
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
  report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    valid: errors.length === 0,
    scope:
      'Bounded synthetic local pilot HTTP acceptance; not a throughput limit, production SLA, TLS test, or external-provider validation.',
    environment: {
      node: process.version,
      platform: platform(),
      osRelease: release(),
      arch: arch(),
      cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: rounded(totalmem() / 1024 ** 3),
      postgres: postgresVersion,
      runtimeRole: 'restricted non-owner',
      providerPlacement: 'same-host in-process simulators, separate databases',
    },
    workload: {
      workspaces: 4,
      ordersPerWorkspace: 100,
      lanesPerWorkspace: 500,
      stockRowsPerWorkspace: 50,
      feasibleTransfersPerWorkspace: 5000,
      clientTimeoutMs,
      independentConcurrency: 4,
      sameWorkspaceConcurrency: 12,
      planningStrategy: 'optimized',
      warmup:
        'imports OR-Tools before measured requests; planning requests still include child-process startup',
      transport: 'loopback HTTP with pilot Host/Origin headers; TLS ingress excluded',
    },
    acceptance: {
      requireZeroInvalidResponses: true,
      requireZeroCrossWorkspaceLeaks: true,
      requireAllFinalExportsConsistent: true,
      expectedContentionStatusCodes: [200, 409],
      expectedCrossWorkspaceStatusCode: 409,
      latencyRule:
        'Every request must finish within the predeclared 15000ms client timeout; percentiles are observations, not promised limits.',
    },
    sourceSha256: hashes,
    phases,
    samples,
    errors,
  };
} catch {
  errors.push(
    'Capacity harness could not complete; inspect setup and dedicated test-cluster availability.',
  );
  process.exitCode = 1;
} finally {
  const cleanupSteps: { resource: string; successful: boolean }[] = [];
  async function cleanupStep(resource: string, action: () => Promise<unknown>) {
    try {
      await action();
      cleanupSteps.push({ resource, successful: true });
    } catch {
      cleanupSteps.push({ resource, successful: false });
      errors.push(`Cleanup failed for ${resource}; subsequent resources were still attempted.`);
    }
  }
  for (const [index, process] of [...children].entries()) {
    await cleanupStep(`subprocess ${index + 1}`, async () => {
      const closed = once(process, 'close');
      process.kill('SIGTERM');
      const timer = setTimeout(() => process.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    });
  }
  await Promise.all(
    services.map((service, index) => cleanupStep(`provider ${index + 1}`, () => service.close())),
  );
  await Promise.all(
    opened.map((pool, index) => cleanupStep(`database pool ${index + 1}`, () => pool.end())),
  );
  for (const [index, name] of created.entries())
    await cleanupStep(`owned database ${index + 1}`, () => admin.query(`DROP DATABASE "${name}"`));
  if (roleCreated)
    await cleanupStep('owned runtime role', () => admin.query(`DROP ROLE "${role}"`));
  await cleanupStep('administration pool', () => admin.end());
  report = {
    ...report,
    generatedAt: new Date().toISOString(),
    valid: errors.length === 0,
    samples,
    errors,
    cleanup: {
      ownedDatabasesCreated: created.length,
      attemptedOnlyOwnedNames: true,
      successful: cleanupSteps.every((step) => step.successful),
      steps: cleanupSteps,
    },
  };
  try {
    await writeFile('docs/evidence/capacity.json', JSON.stringify(report, null, 2) + '\n');
  } catch {
    errors.push('The sanitized capacity report could not be written.');
    report.valid = false;
  }
  console.log(
    JSON.stringify(
      { valid: report.valid, phases: report.phases, cleanup: report.cleanup, errors },
      null,
      2,
    ),
  );
  if (errors.length) process.exitCode = 1;
}
