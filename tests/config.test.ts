import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function startup(settings: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  for (const name of [
    'REPLAN_MODE',
    'NODE_ENV',
    'DATABASE_URL',
    'INVENTORY_URL',
    'CARRIER_URL',
    'PROVIDER_TOKEN',
    'APP_ORIGIN',
  ])
    delete env[name];
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {config} from './src/config.ts'; console.log(config.mode)",
    ],
    {
      env: { ...env, ...settings },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
}
const pilot = {
  REPLAN_MODE: 'pilot',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://unused/example',
  INVENTORY_URL: 'http://inventory:4311',
  CARRIER_URL: 'http://carrier:4312',
  PROVIDER_TOKEN: 'test-only-explicit-service-credential',
  APP_ORIGIN: 'https://pilot.example',
};
it('does not allow a production environment to silently start the unauthenticated demo', () => {
  const result = startup({ NODE_ENV: 'production' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Production startup requires REPLAN_MODE=pilot');
});
it('requires explicit pilot database, provider and origin configuration', () => {
  for (const key of [
    'DATABASE_URL',
    'INVENTORY_URL',
    'CARRIER_URL',
    'PROVIDER_TOKEN',
    'APP_ORIGIN',
  ]) {
    const result = startup({ ...pilot, [key]: undefined });
    expect(result.status, key).not.toBe(0);
    expect(result.stderr, key).toContain(`Pilot startup requires ${key}`);
  }
});
it('requires an exact HTTPS browser origin and a sufficiently long service credential', () => {
  for (const APP_ORIGIN of [
    'http://pilot.example',
    'https://pilot.example/path',
    'https://pilot.example/',
  ])
    expect(startup({ ...pilot, APP_ORIGIN }).status).not.toBe(0);
  expect(startup({ ...pilot, PROVIDER_TOKEN: 'short' }).status).not.toBe(0);
  const result = startup(pilot);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('pilot');
});
