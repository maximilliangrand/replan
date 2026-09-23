import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SCHEMA, type Principal } from '../src/auth.js';
import { operationHealth, type OperationsHealth } from '../src/monitoring.js';
import { asPrincipal } from '../src/workspace.js';

const databaseUrl =
  process.env.TEST_AUTH_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_auth_test';
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Monitoring tests require a database ending in _test.');
const schema = `monitor_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const person: Principal = {
  id: randomUUID(),
  name: 'Monitoring viewer',
  role: 'viewer',
  workspaceId: randomUUID(),
};
const other: Principal = { ...person, id: randomUUID(), workspaceId: randomUUID() };
let schemaCreated = false;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  for (const name of ['001_initial.sql', '002_workspaces.sql'])
    await db.query(await readFile(new URL(`../src/migrations/${name}`, import.meta.url), 'utf8'));
  await db.query(AUTH_SCHEMA);
  await db.query(
    await readFile(new URL('../src/migrations/004_operation_sources.sql', import.meta.url), 'utf8'),
  );
  for (const actor of [person, other])
    await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      actor.workspaceId,
      'Monitoring fixture',
    ]);
});
beforeEach(async () => {
  await db.query('DELETE FROM events');
  await db.query('DELETE FROM plans');
});
afterAll(async () => {
  await db.end();
  try {
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

async function plan(status: string, age = 1200, actor = person, cancelled = false) {
  const id = randomUUID();
  const scenarioId = randomUUID();
  await db.query(
    `INSERT INTO plans(id,scenario_id,strategy,snapshot,solution,hash,status,workspace_id,created_at,approved_at,cancel_reason)
    VALUES($1,$2,'greedy',$3,$3,$4,$5,$6,now()-$7*interval '1 second',now()-$7*interval '1 second',$8)`,
    [
      id,
      scenarioId,
      { privatePayload: 'Do not put this in monitoring output.' },
      'a'.repeat(64),
      status,
      actor.workspaceId,
      age,
      cancelled ? 'Private cancellation reason' : null,
    ],
  );
  return { id, scenarioId, workspaceId: actor.workspaceId };
}
async function event(
  p: Awaited<ReturnType<typeof plan>>,
  kind: string,
  age: number,
  workspaceId = p.workspaceId,
) {
  await db.query(
    "INSERT INTO events(scenario_id,plan_id,workspace_id,kind,message,at) VALUES($1,$2,$3,$4,'Private event detail',now()-$5*interval '1 second')",
    [p.scenarioId, p.id, workspaceId, kind, age],
  );
}
const health = () => asPrincipal(person, () => operationHealth(db));

describe('workspace operational summary', () => {
  it('reports an empty workspace without requiring an imported operation', async () => {
    const result = await health();
    const empty = { count: 0, oldestAgeSeconds: null };
    expect(result).toEqual({
      observedAt: expect.any(String),
      unresolved: empty,
      cancellationPending: empty,
      executing: empty,
    });
    expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
  });

  it('allows each workspace role to read the summary without access to another workspace', async () => {
    await plan('uncertain');
    await plan('uncertain', 10000, other, true);
    for (const role of ['admin', 'operator', 'viewer'] as const) {
      const result = await asPrincipal({ ...person, role }, () => operationHealth(db));
      expect(result.unresolved.count).toBe(1);
      expect(result.cancellationPending.count).toBe(0);
    }
  });

  it('reports only the authenticated workspace and does not expose payloads, reasons, or identifiers', async () => {
    const own = await plan('uncertain');
    await event(own, 'plan.uncertain', 300);
    await plan('uncertain', 10000, other, true);
    await plan('executing', 10000, other);
    // Even inconsistent cross-workspace event data cannot alter this workspace's age.
    await event(own, 'plan.uncertain', 20000, other.workspaceId);
    const result = await health();
    expect(result.unresolved.count).toBe(1);
    expect(result.unresolved.oldestAgeSeconds).toBeGreaterThanOrEqual(300);
    expect(result.unresolved.oldestAgeSeconds).toBeLessThan(305);
    expect(result.executing.count).toBe(0);
    expect(result.cancellationPending.count).toBe(0);
    const output = JSON.stringify(result);
    for (const privateValue of [
      'Private',
      'privatePayload',
      own.id,
      own.scenarioId,
      person.workspaceId,
      other.workspaceId,
    ])
      expect(output).not.toContain(privateValue);
  });

  it('uses the first unresolved/cancellation event, so retrying cannot conceal a stale plan', async () => {
    const p = await plan('uncertain', 6000, person, true);
    await event(p, 'plan.uncertain', 1800);
    await event(p, 'plan.executing', 30);
    await event(p, 'plan.uncertain', 20);
    await event(p, 'plan.cancellation_requested', 900);
    await event(p, 'plan.uncertain', 10);
    const result = await health();
    expect(result.unresolved).toEqual({ count: 1, oldestAgeSeconds: expect.any(Number) });
    expect(result.unresolved.oldestAgeSeconds).toBeGreaterThanOrEqual(1800);
    expect(result.unresolved.oldestAgeSeconds).toBeLessThan(1805);
    expect(result.cancellationPending.count).toBe(1);
    expect(result.cancellationPending.oldestAgeSeconds).toBeGreaterThanOrEqual(900);
    expect(result.cancellationPending.oldestAgeSeconds).toBeLessThan(905);
  });

  it('excludes resolved historical plans and approved work that has not begun', async () => {
    for (const status of ['completed', 'needs_replan', 'superseded', 'proposed']) {
      const p = await plan(status, 20000, person, true);
      await event(p, 'plan.uncertain', 10000);
    }
    await plan('approved', 20000);
    expect((await health()).unresolved.count).toBe(0);
    expect((await health()).cancellationPending.count).toBe(0);
    expect((await health()).executing.count).toBe(0);
  });

  it('uses the oldest active plan and conservative approval fallback for missing history', async () => {
    await plan('uncertain', 1200);
    await plan('uncertain', 2400);
    const active = await plan('executing', 6000);
    await event(active, 'plan.executing', 120);
    const result = await health();
    expect(result.unresolved.count).toBe(2);
    expect(result.unresolved.oldestAgeSeconds).toBeGreaterThanOrEqual(2400);
    expect(result.unresolved.oldestAgeSeconds).toBeLessThan(2405);
    expect(result.executing.count).toBe(1);
    expect(result.executing.oldestAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(result.executing.oldestAgeSeconds).toBeLessThan(125);
  });

  it('clamps future timestamps and falls back to creation when no approval timestamp exists', async () => {
    const p = await plan('uncertain', 600);
    await db.query('UPDATE plans SET approved_at=NULL WHERE id=$1', [p.id]);
    expect((await health()).unresolved.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
    await event(p, 'plan.uncertain', -1200);
    expect((await health()).unresolved.oldestAgeSeconds).toBe(0);
  });
});

describe('read-only HTTPS monitoring command', () => {
  let directory: string;
  let server: Server;
  let origin: string;
  let mode = 'healthy';
  let summary: OperationsHealth;
  let requests: { path: string; authorized: boolean }[];
  const key = `rpl_${randomBytes(32).toString('base64url')}`;
  const extraSecret = 'Sensitive provider body that must never become monitoring output';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'replan-monitor-test-'));
    const cert = join(directory, 'certificate.pem');
    const privateKey = join(directory, 'key.pem');
    const generated = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        privateKey,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    if (generated.status !== 0)
      throw new Error('OpenSSL could not create the ephemeral HTTPS test certificate.');
    server = createServer(
      { key: await readFile(privateKey), cert: await readFile(cert) },
      (request, response) => {
        const path = request.url!;
        requests.push({ path, authorized: request.headers.authorization === `Bearer ${key}` });
        response.setHeader('content-type', 'application/json');
        if (path === '/api/ready') {
          response.statusCode = mode === 'unready' ? 503 : 200;
          response.end(
            JSON.stringify(mode === 'unready' ? { error: key + extraSecret } : { ok: true }),
          );
        } else if (mode === 'redirect') {
          response.writeHead(302, { location: `${origin}/redirect-target` });
          response.end(key + extraSecret);
        } else if (mode === 'unauthorized') {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: key + extraSecret }));
        } else if (mode === 'timeout') {
          // The client's bounded abort must close this request without a retry.
        } else if (mode === 'malformed') {
          response.end(JSON.stringify({ ...summary, secret: key + extraSecret }));
        } else if (mode === 'oversized') {
          response.end(JSON.stringify({ secret: (key + extraSecret).repeat(1000) }));
        } else response.end(JSON.stringify(summary));
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `https://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });
  beforeEach(() => {
    mode = 'healthy';
    requests = [];
    const empty = { count: 0, oldestAgeSeconds: null };
    summary = {
      observedAt: new Date().toISOString(),
      unresolved: empty,
      cancellationPending: empty,
      executing: empty,
    };
  });
  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    if (directory) await rm(directory, { recursive: true });
  });

  async function probe(env: NodeJS.ProcessEnv = {}, args: string[] = []) {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/check-operations.mts'), ...args],
      {
        env: {
          ...process.env,
          REPLAN_MODE: 'pilot',
          NODE_ENV: 'production',
          DATABASE_URL: undefined,
          PROVIDER_TOKEN: undefined,
          REPLAN_MONITOR_ORIGIN: origin,
          REPLAN_MONITOR_KEY: key,
          REPLAN_STALE_AFTER_SECONDS: '900',
          REPLAN_MONITOR_TIMEOUT_MS: '5000',
          NODE_EXTRA_CA_CERTS: join(directory, 'certificate.pem'),
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (data) => {
      stdout += data;
    });
    child.stderr!.on('data', (data) => {
      stderr += data;
    });
    const [code] = await once(child, 'close');
    expect(stdout + stderr).not.toContain(key);
    expect(stdout + stderr).not.toContain(extraSecret);
    return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) : null };
  }

  it('runs against a certificate-verified HTTPS server without database credentials and only performs GETs', async () => {
    const response = await probe();
    expect(response.code).toBe(0);
    expect(response.result).toEqual({
      ok: true,
      ready: true,
      operations: summary,
      stale: [],
      failures: [],
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        { path: '/api/ready', authorized: false },
        { path: '/api/operations/health', authorized: true },
      ]),
    );
    expect(requests).toHaveLength(2);
  });

  it('exits nonzero at the configured stale boundary, including pending cancellation and execution', async () => {
    summary.unresolved = { count: 1, oldestAgeSeconds: 899 };
    expect((await probe()).code).toBe(0);
    summary.unresolved.oldestAgeSeconds = 900;
    summary.cancellationPending = { count: 1, oldestAgeSeconds: 901 };
    summary.executing = { count: 1, oldestAgeSeconds: 902 };
    const response = await probe();
    expect(response.code).toBe(1);
    expect(response.result.stale).toEqual(['unresolved', 'cancellationPending', 'executing']);
    expect(response.result.failures).toEqual([]);
  });

  it('reports an unavailable readiness check without exposing its response body', async () => {
    mode = 'unready';
    const response = await probe();
    expect(response.code).toBe(1);
    expect(response.result).toMatchObject({ ready: false, failures: ['readiness_unavailable'] });
  });

  it('reports revoked or unauthorized credentials as a failure without response details', async () => {
    mode = 'unauthorized';
    const response = await probe();
    expect(response.code).toBe(1);
    expect(response.result).toMatchObject({
      operations: null,
      failures: ['authentication_failed'],
    });
  });

  it('refuses redirects without forwarding a credential or issuing a follow-up request', async () => {
    mode = 'redirect';
    const response = await probe();
    expect(response.code).toBe(1);
    expect(response.result.failures).toContain('operations_unavailable');
    expect(requests.some((request) => request.path === '/redirect-target')).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it('bounds the response size and validates the exact report shape', async () => {
    for (const value of ['malformed', 'oversized']) {
      mode = value;
      const response = await probe();
      expect(response.code).toBe(1);
      expect(response.result).toMatchObject({ operations: null, failures: ['invalid_response'] });
    }
  });

  it('times out a stalled request without retrying or weakening TLS validation', async () => {
    mode = 'timeout';
    const response = await probe({ REPLAN_MONITOR_TIMEOUT_MS: '100' });
    expect(response.code).toBe(1);
    expect(response.result.failures).toContain('operations_unavailable');
    expect(requests.filter((request) => request.path === '/api/operations/health')).toHaveLength(1);
  });

  it('rejects an untrusted server certificate before sending a credential', async () => {
    const response = await probe({ NODE_EXTRA_CA_CERTS: undefined });
    expect(response.code).toBe(1);
    expect(response.result).toMatchObject({
      ready: false,
      operations: null,
      failures: ['readiness_unavailable', 'operations_unavailable'],
    });
    expect(requests).toHaveLength(0);
  });

  it('rejects HTTP, embedded credentials, invalid thresholds, and command-line secrets before connecting', async () => {
    for (const env of [
      { REPLAN_MONITOR_ORIGIN: origin.replace('https:', 'http:') },
      { REPLAN_MONITOR_ORIGIN: `https://${key}@127.0.0.1` },
      { REPLAN_MONITOR_ORIGIN: `${origin}/` },
      { REPLAN_STALE_AFTER_SECONDS: '0' },
      { REPLAN_MONITOR_TIMEOUT_MS: 'NaN' },
      { REPLAN_MONITOR_KEY: undefined },
    ])
      expect((await probe(env)).code).toBe(2);
    expect((await probe({}, ['--key', key])).code).toBe(2);
    expect(requests).toHaveLength(0);
  });
});
