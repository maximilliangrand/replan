import Fastify from 'fastify';
import { Pool } from 'pg';
import { z, ZodError } from 'zod';

export const identifier = z.string().min(1).max(160);
export const scenarioId = z.uuid();
export const quantity = z.number().int().min(1).max(1_000_000);
export const version = z.number().int().min(0).max(2_000_000_000);

export class ServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function service(databaseURL: string) {
  const pool = new Pool({ connectionString: databaseURL, max: 8 });
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  app.addHook('onRequest', async (request, reply) => {
    const allowed = new Set(['localhost', '127.0.0.1', '[::1]', 'inventory', 'carrier']);
    try {
      if (!allowed.has(new URL(`http://${request.headers.host}`).hostname))
        throw new Error('untrusted host');
      if (
        request.headers.origin &&
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.headers.origin).hostname)
      )
        throw new Error('untrusted origin');
    } catch {
      return reply.code(403).send({ error: 'Simulator access is restricted to the local demo.' });
    }
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        details: error.issues.map(({ path, message }) => ({ path, message })),
      });
    }
    if (error instanceof ServiceError)
      return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({ error: 'Invalid request' });
    request.log.error(error);
    return reply.code(500).send({ error: 'Service could not complete this request' });
  });
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });
  return { app, pool };
}

/** PostgreSQL JSONB may reorder object keys; equality compares the parsed structure. */
export function samePayload(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        samePayload(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
