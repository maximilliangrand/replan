import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_SCHEMA,
  provisionOperator,
  registerAuth,
  revokeOperator,
  rotateOperatorKey,
  type Principal,
} from '../src/auth.js';

const databaseUrl =
  process.env.TEST_AUTH_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_auth_test';
if (!new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Auth tests require a dedicated database with a name ending in _test.');
const schema = `auth_test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
const db = new pg.Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schema}`,
  application_name: schema,
});
const workspaceId = randomUUID();
const origin = 'https://replan.example';
const demoPrincipal: Principal = {
  id: randomUUID(),
  name: 'Demo operator',
  role: 'admin',
  workspaceId,
};
const apps: FastifyInstance[] = [];
let app: FastifyInstance;
let schemaCreated = false;
let operator: Awaited<ReturnType<typeof provisionOperator>>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function server(mode: 'demo' | 'pilot' = 'pilot') {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  await registerAuth(instance, db, {
    mode,
    secureCookies: mode === 'pilot',
    allowedOrigins: [origin],
    demoPrincipal,
  });
  instance.get('/api/health', async () => ({ ok: true }));
  instance.get('/api/ready', async () => ({ ok: true }));
  instance.get('/api/private', async (request) => ({ principal: request.principal }));
  instance.post('/api/private', async (request) => ({ principal: request.principal }));
  instance.get('/', async () => 'Sign in');
  return instance;
}

async function login(key: string, instance = app) {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { key },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers['set-cookie'];
  expect(typeof header).toBe('string');
  return { response, cookie: (header as string).split(';')[0] };
}

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await db.query('CREATE TABLE workspaces(id uuid PRIMARY KEY, name text NOT NULL)');
  await db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [workspaceId, 'Auth test']);
  await db.query(AUTH_SCHEMA);
});
beforeEach(async () => {
  await db.query('DELETE FROM operators');
  operator = await provisionOperator(db, { name: 'Jamie Operator', role: 'operator', workspaceId });
  app = await server();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});
afterAll(async () => {
  await db.end();
  try {
    if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

describe('provisioned pilot identities', () => {
  it('protects API data while keeping static assets and minimal health/session discovery public', async () => {
    for (const path of ['/api/private', '/api/private?download=1', '/api/unknown']) {
      expect((await app.inject({ url: path })).statusCode).toBe(401);
    }
    for (const path of ['/', '/api/health', '/api/ready']) {
      expect((await app.inject({ url: path })).statusCode).toBe(200);
    }
    const session = await app.inject({ url: '/api/session' });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ mode: 'pilot', principal: null });
    expect(session.headers['cache-control']).toBe('no-store');
  });

  it('stores only high-entropy credential hashes and issues a bounded secure browser session', async () => {
    expect(operator.key).toMatch(/^rpl_[A-Za-z0-9_-]{43}$/);
    const stored = (await db.query('SELECT * FROM operators WHERE id=$1', [operator.principal.id]))
      .rows[0];
    expect(stored.key_hash).toBe(digest(operator.key));
    expect(JSON.stringify(stored)).not.toContain(operator.key);
    const { response, cookie } = await login(operator.key);
    expect(response.json()).toEqual({ mode: 'pilot', principal: operator.principal });
    expect(response.body).not.toContain(operator.key);
    expect(response.headers['set-cookie']).toContain('__Host-replan_session=');
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) {
      expect(response.headers['set-cookie']).toContain(attribute);
    }
    expect(response.headers['set-cookie']).not.toContain('Domain=');
    const token = cookie.split('=')[1];
    const storedSession = (await db.query('SELECT * FROM auth_sessions')).rows[0];
    expect(storedSession.token_hash).toBe(digest(token));
    expect(JSON.stringify(storedSession)).not.toContain(token);
    expect(storedSession.expires_at.getTime() - storedSession.created_at.getTime()).toBe(
      8 * 3600 * 1000,
    );
    const privateResponse = await app.inject({ url: '/api/private', headers: { cookie } });
    expect(privateResponse.statusCode).toBe(200);
    expect(privateResponse.json().principal).toEqual(operator.principal);
  });

  it('carries the database-assigned role and workspace instead of client role claims', async () => {
    const viewer = await provisionOperator(db, { name: 'Read only', role: 'viewer', workspaceId });
    const response = await app.inject({
      url: '/api/private',
      headers: {
        authorization: `Bearer ${viewer.key}`,
        'x-role': 'admin',
        'x-workspace-id': randomUUID(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().principal).toEqual(viewer.principal);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { key: viewer.key, role: 'admin' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('rejects missing, invalid, unknown, and cookie-shaped bearer credentials without exposing values', async () => {
    for (const key of ['', 'password', `rpl_${'A'.repeat(43)}`]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { key },
      });
      expect(response.statusCode).toBe(key.length === 47 ? 401 : 400);
      if (key) expect(response.body).not.toContain(key);
    }
    const { cookie } = await login(operator.key);
    for (const authorization of [
      'Basic invalid',
      `Bearer ${cookie.split('=')[1]}`,
      'Bearer invalid',
    ]) {
      const response = await app.inject({
        url: '/api/private',
        headers: { cookie, authorization },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('requires an exact allowlisted origin for login and authenticated mutations', async () => {
    const { cookie } = await login(operator.key);
    for (const bad of [
      'https://evil.example',
      `${origin}.evil.example`,
      `${origin}:8443`,
      'null',
    ]) {
      for (const url of ['/api/auth/login', '/api/auth/logout', '/api/private']) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { origin: bad, cookie },
          payload: { key: operator.key },
        });
        expect(response.statusCode).toBe(403);
      }
    }
    // Non-browser clients can authenticate without manufacturing an Origin header.
    const cli = await app.inject({
      method: 'POST',
      url: '/api/private',
      headers: { authorization: `Bearer ${operator.key}` },
      payload: {},
    });
    expect(cli.statusCode).toBe(200);
  });

  it('invalidates expired sessions without extending their lifetime on a request', async () => {
    const { cookie } = await login(operator.key);
    const original = (await db.query('SELECT expires_at FROM auth_sessions')).rows[0].expires_at;
    await app.inject({ url: '/api/private', headers: { cookie } });
    expect((await db.query('SELECT expires_at FROM auth_sessions')).rows[0].expires_at).toEqual(
      original,
    );
    await db.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second'");
    expect((await app.inject({ url: '/api/private', headers: { cookie } })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/session', headers: { cookie } })).json().principal,
    ).toBeNull();
  });

  it('bounds stored sessions and evicts the oldest session without invalidating newer ones', async () => {
    const first = await login(operator.key);
    for (let count = 1; count < 10; count++) await login(operator.key);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '127.0.0.2',
      payload: { key: operator.key },
    });
    expect(response.statusCode).toBe(200);
    expect((await db.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(10);
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: first.cookie } })).statusCode,
    ).toBe(401);
    const newestCookie = String(response.headers['set-cookie']).split(';')[0];
    expect(
      (await app.inject({ url: '/api/private', headers: { cookie: newestCookie } })).statusCode,
    ).toBe(200);
  });

  it('signs out by deleting the server-side session and expiring its cookie', async () => {
    const { cookie } = await login(operator.key);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect((await db.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(0);
    expect((await app.inject({ url: '/api/private', headers: { cookie } })).statusCode).toBe(401);
  });

  it('revokes all sessions and API access for a disabled operator', async () => {
    const { cookie } = await login(operator.key);
    await revokeOperator(db, operator.principal.id);
    for (const headers of [{ cookie }, { authorization: `Bearer ${operator.key}` }]) {
      expect((await app.inject({ url: '/api/private', headers })).statusCode).toBe(401);
    }
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { key: operator.key },
    });
    expect(loginResponse.statusCode).toBe(401);
    expect((await db.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(0);
    await expect(rotateOperatorKey(db, operator.principal.id)).rejects.toThrow(
      'Active operator not found',
    );
  });

  it('rotates keys and invalidates every previous session while preserving attribution', async () => {
    const sessions = [await login(operator.key), await login(operator.key)];
    const rotated = await rotateOperatorKey(db, operator.principal.id);
    expect(rotated.key).not.toBe(operator.key);
    expect(rotated.principal).toEqual(operator.principal);
    for (const { cookie } of sessions) {
      expect((await app.inject({ url: '/api/private', headers: { cookie } })).statusCode).toBe(401);
    }
    expect(
      (
        await app.inject({
          url: '/api/private',
          headers: { authorization: `Bearer ${operator.key}` },
        })
      ).statusCode,
    ).toBe(401);
    await login(rotated.key);
  });

  it('rate limits repeated login attempts with a bounded IP store', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { key: `rpl_${'A'.repeat(43)}` },
          })
        ).statusCode,
      ).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { key: operator.key },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('does not let concurrent login leave an old-key session after rotation', async () => {
    // Hold the row so both transactions must cross the same authorization boundary.
    const blocker = await db.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM operators WHERE id=$1 FOR UPDATE', [
        operator.principal.id,
      ]);
      const rotation = rotateOperatorKey(db, operator.principal.id);
      const signIn = app
        .inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { key: operator.key },
        })
        .then((response) => response);
      await expect
        .poll(async () =>
          Number(
            (
              await db.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
                [schema],
              )
            ).rows[0].count,
          ),
        )
        .toBe(2);
      await blocker.query('COMMIT');
      const [rotated, signedIn] = await Promise.all([rotation, signIn]);
      expect([200, 401]).toContain(signedIn.statusCode);
      if (signedIn.statusCode === 200) {
        const cookie = String(signedIn.headers['set-cookie']).split(';')[0];
        expect((await app.inject({ url: '/api/private', headers: { cookie } })).statusCode).toBe(
          401,
        );
      }
      expect((await db.query('SELECT 1 FROM auth_sessions')).rowCount).toBe(0);
      await login(rotated.key);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('keeps demo identity explicit without provisioning a transferable key', async () => {
    const demo = await server('demo');
    const response = await demo.inject({ url: '/api/session' });
    expect(response.json()).toEqual({ mode: 'demo', principal: demoPrincipal });
    expect((await demo.inject({ url: '/api/private' })).json().principal).toEqual(demoPrincipal);
    expect(
      (
        await demo.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { key: operator.key },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rejects invalid provisioning inputs before creating an identity', async () => {
    for (const name of ['', ' '.repeat(2), 'x'.repeat(101), 'Operator\nAdmin']) {
      await expect(
        provisionOperator(db, { name, role: 'operator', workspaceId }),
      ).rejects.toThrow();
    }
    await expect(
      provisionOperator(db, { name: 'Other', role: 'viewer', workspaceId: randomUUID() }),
    ).rejects.toThrow();
    expect((await db.query('SELECT 1 FROM operators')).rowCount).toBe(1);
  });

  it('fails configuration before accepting insecure pilot browser sessions', async () => {
    const insecure = Fastify();
    apps.push(insecure);
    await expect(
      registerAuth(insecure, db, {
        mode: 'pilot',
        secureCookies: false,
        allowedOrigins: [origin],
        demoPrincipal,
      }),
    ).rejects.toThrow('HTTPS');
  });
});
