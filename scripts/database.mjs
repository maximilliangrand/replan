import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';

const root = resolve(import.meta.dirname, '..');
const local = join(root, '.local');
const data = join(local, 'postgres');
const port = Number(process.env.REPLAN_PG_PORT ?? 55432);
const owner = join(local, 'postgres-owner');
function pg(tool) {
  for (const prefix of [
    process.env.PG_BIN,
    '/opt/homebrew/opt/postgresql@16/bin',
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/lib/postgresql/18/bin',
  ]) {
    if (prefix && existsSync(join(prefix, tool))) return join(prefix, tool);
  }
  return tool;
}
function run(tool, args, options = {}) {
  const out = spawnSync(pg(tool), args, { encoding: 'utf8', ...options });
  if (out.error || out.status !== 0)
    throw new Error(out.error?.message ?? out.stderr ?? `${tool} failed`);
  return out.stdout;
}
async function portFree() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
export async function startDatabase() {
  mkdirSync(local, { recursive: true });
  if (existsSync(data) && (!existsSync(owner) || readFileSync(owner, 'utf8') !== root)) {
    throw new Error('Refusing to use an unowned PostgreSQL directory. Choose a fresh checkout.');
  }
  if (!existsSync(data)) {
    run('initdb', [
      '-D',
      data,
      '-U',
      'replan',
      '--auth-local=trust',
      '--auth-host=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]);
    writeFileSync(owner, root);
  }
  const status = spawnSync(pg('pg_ctl'), ['-D', data, 'status'], { encoding: 'utf8' });
  if (status.status === 0) {
    const runningPort = Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[3]);
    if (runningPort !== port)
      throw new Error(
        `This checkout's cluster is already running on ${runningPort}. Use that port, or stop it before changing REPLAN_PG_PORT.`,
      );
  }
  if (status.status !== 0) {
    if (!(await portFree()))
      throw new Error(
        `Port ${port} is occupied. Replan will not touch that server. Set REPLAN_PG_PORT to a free port.`,
      );
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      join(local, 'postgres.log'),
      '-o',
      `-p ${port} -h 127.0.0.1 -k ''`,
      '-w',
      'start',
    ]);
  }
  const actualDirectory = run('psql', [
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-U',
    'replan',
    '-d',
    'postgres',
    '-tAc',
    'SHOW data_directory',
  ]).trim();
  if (resolve(actualDirectory) !== data)
    throw new Error('Database ownership verification failed. No databases were created.');
  for (const name of [
    'replan',
    'replan_inventory',
    'replan_carrier',
    'replan_test',
    'replan_inventory_test',
    'replan_carrier_test',
    'replan_auth_test',
    'replan_pilot_test',
  ]) {
    const present = run('psql', [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      'replan',
      '-d',
      'postgres',
      '-tAc',
      `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
    ]).trim();
    if (!present) run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'replan', name]);
  }
  console.log(`Replan's isolated PostgreSQL is ready on 127.0.0.1:${port}.`);
}
export function stopDatabase() {
  if (!existsSync(owner) || readFileSync(owner, 'utf8') !== root)
    throw new Error('No owned Replan cluster to stop.');
  run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
}
if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  try {
    if (process.argv[2] === 'stop') stopDatabase();
    else await startDatabase();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
