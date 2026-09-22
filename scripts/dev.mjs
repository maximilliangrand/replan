import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDatabase } from './database.mjs';

process.chdir(resolve(import.meta.dirname, '..'));
const children = new Set();
let stopping = false;
function command(bin, args, options = {}) {
  const child = spawn(bin, args, { stdio: 'inherit', ...options });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  return child;
}
function once(bin, args) {
  return new Promise((resolve, reject) =>
    command(bin, args).on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`)),
    ),
  );
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
  console.log('\nServices stopped. The owned database is retained; npm run db:stop shuts it down.');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
async function healthy(url) {
  for (let i = 0; i < 100 && !stopping; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Service did not become ready: ${url}`);
}
try {
  if (
    [
      'PORT',
      'INVENTORY_PORT',
      'CARRIER_PORT',
      'HOST',
      'INVENTORY_URL',
      'CARRIER_URL',
      'DATABASE_URL',
      'INVENTORY_DATABASE_URL',
      'CARRIER_DATABASE_URL',
    ].some((key) => process.env[key])
  )
    throw new Error(
      'npm run dev uses its own loopback databases and fixed service ports 4310/4311/4312/4317. Unset connection overrides, or start services individually.',
    );
  if (!existsSync('node_modules/.package-lock.json')) await once('npm', ['ci']);
  await once('uv', ['sync', '--project', 'solver', '--frozen']);
  // Pay the native-library cold-start cost during setup, outside a user request.
  await once('uv', [
    'run',
    '--frozen',
    '--project',
    'solver',
    'python',
    '-c',
    'from ortools.sat.python import cp_model',
  ]);
  await startDatabase();
  const port = process.env.REPLAN_PG_PORT ?? '55432';
  const env = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? `postgres://replan@127.0.0.1:${port}/replan`,
    INVENTORY_DATABASE_URL:
      process.env.INVENTORY_DATABASE_URL ?? `postgres://replan@127.0.0.1:${port}/replan_inventory`,
    CARRIER_DATABASE_URL:
      process.env.CARRIER_DATABASE_URL ?? `postgres://replan@127.0.0.1:${port}/replan_carrier`,
  };
  for (const service of ['inventory', 'carrier']) {
    command(process.execPath, ['--import', 'tsx', 'src/simulators/server.ts', service], { env }).on(
      'exit',
      (code) => {
        if (!stopping) stop(code || 1);
      },
    );
  }
  await Promise.all([
    healthy('http://127.0.0.1:4311/health'),
    healthy('http://127.0.0.1:4312/health'),
  ]);
  function backend() {
    command(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env }).on('exit', (code) => {
      if (!stopping && code === 86) {
        console.log('Injected crash detected. Restarting Replan from durable state…');
        setTimeout(backend, 300);
      } else if (!stopping) stop(code || 1);
    });
  }
  backend();
  await healthy('http://127.0.0.1:4310/api/health');
  command(process.execPath, ['node_modules/vite/bin/vite.js']).on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
} catch (error) {
  console.error(error.message);
  stop(1);
}
