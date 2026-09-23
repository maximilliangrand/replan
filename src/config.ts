import { z } from 'zod';

const mode = process.env.REPLAN_MODE ?? 'demo';
if (!['demo', 'pilot'].includes(mode)) throw new Error('REPLAN_MODE must be demo or pilot.');
if (process.env.NODE_ENV === 'production' && mode !== 'pilot')
  throw new Error('Production startup requires REPLAN_MODE=pilot.');
const appOrigin = process.env.APP_ORIGIN;
const syntheticProviders = process.env.REPLAN_SYNTHETIC_PROVIDERS ?? 'false';
if (!['true', 'false'].includes(syntheticProviders))
  throw new Error('REPLAN_SYNTHETIC_PROVIDERS must be true or false.');
const healthcheckHostname = process.env.HEALTHCHECK_HOSTNAME;
if (healthcheckHostname !== undefined && !z.hostname().safeParse(healthcheckHostname).success)
  throw new Error(
    'HEALTHCHECK_HOSTNAME must be a single DNS hostname without a scheme, port or wildcard.',
  );
if (mode === 'pilot') {
  for (const key of [
    'DATABASE_URL',
    'INVENTORY_URL',
    'CARRIER_URL',
    'PROVIDER_TOKEN',
    'APP_ORIGIN',
  ]) {
    if (!process.env[key]) throw new Error(`Pilot startup requires ${key}.`);
  }
  const origin = new URL(appOrigin!);
  if (origin.protocol !== 'https:' || origin.origin !== appOrigin)
    throw new Error('APP_ORIGIN must be an HTTPS origin without a path.');
  if (process.env.PROVIDER_TOKEN!.length < 32)
    throw new Error('PROVIDER_TOKEN must contain at least 32 characters.');
}
export const config = {
  mode: mode as 'demo' | 'pilot',
  appOrigin,
  syntheticProviders: syntheticProviders === 'true',
  healthcheckHostname,
  providerToken: process.env.PROVIDER_TOKEN,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan',
  inventoryUrl: process.env.INVENTORY_URL ?? 'http://127.0.0.1:4311',
  carrierUrl: process.env.CARRIER_URL ?? 'http://127.0.0.1:4312',
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4310),
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? 2000),
};
