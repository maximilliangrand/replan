import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { OperationsHealth } from '../src/monitoring.js';

const ageSchema = z
  .object({
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    oldestAgeSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict()
  .refine((value) => (value.count === 0) === (value.oldestAgeSeconds === null));
const healthSchema = z
  .object({
    observedAt: z.iso.datetime(),
    unresolved: ageSchema,
    cancellationPending: ageSchema,
    executing: ageSchema,
  })
  .strict();
const categories = ['unresolved', 'cancellationPending', 'executing'] as const;
type Failure =
  | 'readiness_unavailable'
  | 'operations_unavailable'
  | 'authentication_failed'
  | 'invalid_response';
class ConfigurationError extends Error {}
export interface ProbeResult {
  ok: boolean;
  ready: boolean;
  operations: OperationsHealth | null;
  stale: (typeof categories)[number][];
  failures: Failure[];
}

async function json(response: Response): Promise<unknown> {
  // Health responses are tiny. Never buffer arbitrary upstream error pages or
  // echo their contents into a scheduler log that may have wider access.
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) throw new Error('Response too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function checkOperations(options: {
  origin: string;
  key: string;
  staleAfterSeconds: number;
  timeoutMs: number;
}): Promise<ProbeResult> {
  const result: ProbeResult = {
    ok: false,
    ready: false,
    operations: null,
    stale: [],
    failures: [],
  };
  const replies = await Promise.allSettled([
    fetch(`${options.origin}/api/ready`, {
      headers: { authorization: `Bearer ${options.key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    }),
    fetch(`${options.origin}/api/operations/health`, {
      headers: { authorization: `Bearer ${options.key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    }),
  ]);
  const readiness = replies[0];
  if (readiness.status === 'fulfilled' && readiness.value.ok) {
    try {
      result.ready = z
        .object({ ok: z.literal(true) })
        .strict()
        .safeParse(await json(readiness.value)).success;
    } catch {
      /* Report a fixed failure code, never the received body. */
    }
  } else if (readiness.status === 'fulfilled') {
    await readiness.value.body?.cancel().catch(() => {});
  }
  if (!result.ready) result.failures.push('readiness_unavailable');

  const operations = replies[1];
  if (operations.status === 'rejected') result.failures.push('operations_unavailable');
  else if (!operations.value.ok) {
    result.failures.push(
      [401, 403].includes(operations.value.status)
        ? 'authentication_failed'
        : 'operations_unavailable',
    );
    await operations.value.body?.cancel().catch(() => {});
  } else {
    try {
      result.operations = healthSchema.parse(await json(operations.value));
    } catch {
      result.failures.push('invalid_response');
    }
  }
  if (result.operations) {
    result.stale = categories.filter((category) => {
      const age = result.operations![category].oldestAgeSeconds;
      return age !== null && age >= options.staleAfterSeconds;
    });
  }
  result.ok = result.ready && result.failures.length === 0 && result.stale.length === 0;
  return result;
}

async function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    process.stdout.write(`Read-only pilot monitor. No retries, mutations, or notifications are sent.
Set REPLAN_MONITOR_ORIGIN to the exact HTTPS origin (APP_ORIGIN is also accepted).
Set REPLAN_MONITOR_KEY privately in the environment to a provisioned viewer key.
Optional: REPLAN_STALE_AFTER_SECONDS (default 900, range 1..604800).
Optional: REPLAN_MONITOR_TIMEOUT_MS (default 5000, range 100..60000).
Run: npm run check:operations
Exit codes: 0 healthy; 1 unavailable, unauthorized, invalid, or stale; 2 configuration error.
`);
    return;
  }
  if (process.argv.length > 2)
    throw new ConfigurationError(
      'Credentials and settings must be supplied through the environment, not arguments.',
    );
  const origin = process.env.REPLAN_MONITOR_ORIGIN ?? process.env.APP_ORIGIN;
  let url: URL;
  try {
    url = new URL(origin ?? '');
  } catch {
    throw new ConfigurationError('Set REPLAN_MONITOR_ORIGIN to an exact HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw new ConfigurationError(
      'Set REPLAN_MONITOR_ORIGIN to an exact HTTPS origin without credentials, path, or trailing slash.',
    );
  const key = process.env.REPLAN_MONITOR_KEY;
  if (!key || !/^rpl_[A-Za-z0-9_-]{43}$/.test(key))
    throw new ConfigurationError(
      'Set REPLAN_MONITOR_KEY privately to a provisioned workspace access key; viewer is recommended.',
    );
  const seconds = process.env.REPLAN_STALE_AFTER_SECONDS ?? '900';
  const timeout = process.env.REPLAN_MONITOR_TIMEOUT_MS ?? '5000';
  if (!/^\d+$/.test(seconds) || !/^\d+$/.test(timeout))
    throw new ConfigurationError('Monitoring thresholds must be positive integer values.');
  const staleAfterSeconds = Number(seconds);
  const timeoutMs = Number(timeout);
  if (staleAfterSeconds < 1 || staleAfterSeconds > 604800 || timeoutMs < 100 || timeoutMs > 60000)
    throw new ConfigurationError('Monitoring thresholds are outside their documented bounds.');
  const result = await checkOperations({ origin, key, staleAfterSeconds, timeoutMs });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    // These errors are local configuration messages, not provider/HTTP exceptions.
    process.stderr.write(
      `${error instanceof ConfigurationError ? error.message : 'Monitoring failed before a report could be completed.'}\n`,
    );
    process.exitCode = 2;
  });
}
