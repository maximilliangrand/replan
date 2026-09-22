import { createHash, randomBytes, randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

export type Principal = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
  workspaceId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export const AUTH_SCHEMA = `
  CREATE TABLE operators (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 100),
    role text NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
    workspace_id uuid NOT NULL REFERENCES workspaces(id),
    key_hash text NOT NULL UNIQUE CHECK(key_hash ~ '^[a-f0-9]{64}$'),
    disabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE auth_sessions (
    token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
    operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX auth_sessions_operator ON auth_sessions(operator_id);
  CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
`;

const operatorInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    role: z.enum(['admin', 'operator', 'viewer']),
    workspaceId: z.uuid(),
  })
  .strict();
const keyPattern = /^rpl_[A-Za-z0-9_-]{43}$/;
const sessionPattern = /^rps_[A-Za-z0-9_-]{43}$/;
const sessionSeconds = 8 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const newKey = () => `rpl_${randomBytes(32).toString('base64url')}`;
const principalFromRow = (row: pg.QueryResultRow): Principal => ({
  id: row.id,
  name: row.name,
  role: row.role,
  workspaceId: row.workspace_id,
});

export async function provisionOperator(
  pool: pg.Pool,
  input: Omit<Principal, 'id'>,
): Promise<{ principal: Principal; key: string }> {
  const value = operatorInput.parse(input);
  const principal: Principal = { id: randomUUID(), ...value };
  const key = newKey();
  await pool.query(
    'INSERT INTO operators(id,name,role,workspace_id,key_hash) VALUES($1,$2,$3,$4,$5)',
    [principal.id, principal.name, principal.role, principal.workspaceId, digest(key)],
  );
  return { principal, key };
}

export async function rotateOperatorKey(
  pool: pg.Pool,
  id: string,
): Promise<{ principal: Principal; key: string }> {
  z.uuid().parse(id);
  const db = await pool.connect();
  const key = newKey();
  try {
    await db.query('BEGIN');
    // The update locks the operator row, also held when a login creates a session.
    // Rotation cannot race a successful login and leave its old-key session alive.
    const result = await db.query(
      'UPDATE operators SET key_hash=$2 WHERE id=$1 AND NOT disabled RETURNING *',
      [id, digest(key)],
    );
    if (!result.rowCount) throw new Error('Active operator not found.');
    await db.query('DELETE FROM auth_sessions WHERE operator_id=$1', [id]);
    await db.query('COMMIT');
    return { principal: principalFromRow(result.rows[0]), key };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function revokeOperator(pool: pg.Pool, id: string): Promise<void> {
  z.uuid().parse(id);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await db.query('UPDATE operators SET disabled=true WHERE id=$1', [id]);
    if (!result.rowCount) throw new Error('Operator not found.');
    await db.query('DELETE FROM auth_sessions WHERE operator_id=$1', [id]);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function createSession(pool: pg.Pool, key: string) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await db.query(
      'SELECT * FROM operators WHERE key_hash=$1 AND NOT disabled FOR UPDATE',
      [digest(key)],
    );
    if (!result.rowCount) {
      await db.query('ROLLBACK');
      return null;
    }
    const principal = principalFromRow(result.rows[0]);
    const token = `rps_${randomBytes(32).toString('base64url')}`;
    await db.query('DELETE FROM auth_sessions WHERE operator_id=$1 AND expires_at <= now()', [
      principal.id,
    ]);
    // Bound persistent sessions per person without extending any existing session.
    await db.query(
      `DELETE FROM auth_sessions WHERE token_hash IN (
        SELECT token_hash FROM auth_sessions WHERE operator_id=$1
        ORDER BY created_at DESC, token_hash OFFSET 9
      )`,
      [principal.id],
    );
    await db.query(
      `INSERT INTO auth_sessions(token_hash,operator_id,expires_at)
       VALUES($1,$2,now() + interval '8 hours')`,
      [digest(token), principal.id],
    );
    await db.query('COMMIT');
    return { principal, token };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

async function authenticate(pool: pg.Pool, req: FastifyRequest, cookieName: string) {
  if (req.headers.authorization !== undefined) {
    const bearer = /^Bearer (rpl_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
    if (!bearer) return null;
    const result = await pool.query('SELECT * FROM operators WHERE key_hash=$1 AND NOT disabled', [
      digest(bearer[1]),
    ]);
    return result.rowCount ? principalFromRow(result.rows[0]) : null;
  }
  const token = req.cookies[cookieName];
  if (!token || !sessionPattern.test(token)) return null;
  const result = await pool.query(
    `SELECT o.* FROM auth_sessions s JOIN operators o ON o.id=s.operator_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT o.disabled`,
    [digest(token)],
  );
  return result.rowCount ? principalFromRow(result.rows[0]) : null;
}

export async function registerAuth(
  app: FastifyInstance,
  pool: pg.Pool,
  options: {
    mode: 'demo' | 'pilot';
    secureCookies: boolean;
    allowedOrigins: string[];
    demoPrincipal: Principal;
  },
) {
  if (options.mode === 'pilot' && !options.secureCookies)
    throw new Error('Pilot browser sessions require secure cookies and HTTPS.');
  for (const origin of options.allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol))
      throw new Error('Allowed origins must be exact HTTP(S) origins without paths.');
  }
  const origins = new Set(options.allowedOrigins);
  const cookieName = options.secureCookies ? '__Host-replan_session' : 'replan_session';
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: options.secureCookies,
    sameSite: 'strict' as const,
  };
  await app.register(cookie);
  // Local bounded IP limiter. Multiple replicas also need a shared ingress limiter.
  await app.register(rateLimit, { global: false, cache: 5000 });
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path !== '/api' && !path.startsWith('/api/')) return;
    reply.header('cache-control', 'no-store');
    if (options.mode === 'pilot' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== undefined && !origins.has(req.headers.origin))
        return reply.code(403).send({ error: 'Cross-origin access is not allowed.' });
    }
    if (options.mode === 'demo') {
      req.principal = options.demoPrincipal;
      return;
    }
    if (['/api/health', '/api/ready', '/api/auth/login'].includes(path)) return;
    req.principal = await authenticate(pool, req, cookieName);
    if (!req.principal && path !== '/api/session')
      return reply.code(401).send({ error: 'Sign in with a provisioned operator access key.' });
  });

  app.get('/api/session', async (req) => ({ mode: options.mode, principal: req.principal }));
  app.post(
    '/api/auth/login',
    { bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (options.mode === 'demo')
        return reply.code(400).send({ error: 'Access keys are only used in pilot mode.' });
      const parsed = z
        .object({ key: z.string().regex(keyPattern) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid sign-in request.' });
      const session = await createSession(pool, parsed.data.key);
      if (!session) return reply.code(401).send({ error: 'Invalid or revoked access key.' });
      reply.setCookie(cookieName, session.token, { ...cookieOptions, maxAge: sessionSeconds });
      return { mode: options.mode, principal: session.principal };
    },
  );
  app.post('/api/auth/logout', async (req, reply) => {
    if (!z.object({}).strict().safeParse(req.body).success)
      return reply.code(400).send({ error: 'Invalid sign-out request.' });
    const token = req.cookies[cookieName];
    if (token && sessionPattern.test(token))
      await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(token)]);
    reply.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  });
}
