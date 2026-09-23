import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Exact production names are tested only in a newly initialized, owned cluster.
// No existing service, database, role, credential file or global setting is used.
let directory = '';
let running = false;
let admin: pg.Client | undefined;
let adminUrl: URL;
const adminPassword = randomBytes(32).toString('hex');
const passwords = {
  replan_owner: `${randomBytes(32).toString('hex')}'quoted\\password`,
  replan_runtime: randomBytes(32).toString('hex'),
  inventory_owner: randomBytes(32).toString('hex'),
  carrier_owner: randomBytes(32).toString('hex'),
};
const roleNames = Object.keys(passwords);
const databaseNames = ['replan', 'inventory', 'carrier'];

function binary(name: string) {
  if (process.env.PG_BIN) {
    const candidate = join(process.env.PG_BIN, name);
    if (!existsSync(candidate))
      throw new Error(
        'Bootstrap integration tests require PostgreSQL 16 server binaries in PG_BIN.',
      );
    return candidate;
  }
  for (const prefix of ['/opt/homebrew/opt/postgresql@16/bin', '/usr/lib/postgresql/16/bin']) {
    if (prefix && existsSync(join(prefix, name))) return join(prefix, name);
  }
  return name;
}
function pgCommand(name: string, args: string[]) {
  const result = spawnSync(binary(name), args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT')
    throw new Error(
      'Bootstrap integration tests require PostgreSQL 16 server binaries; set PG_BIN to their bin directory.',
    );
  if (result.error || result.status !== 0)
    throw new Error(`Owned PostgreSQL test cluster ${name} failed.`);
  return result.stdout;
}
function connection(role: keyof typeof passwords, database: string, password = passwords[role]) {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
}
function invoke(overrides: NodeJS.ProcessEnv = {}) {
  const environment = {
    ...process.env,
    BOOTSTRAP_DATABASE_URL: adminUrl.toString(),
    REPLAN_OWNER_PASSWORD: passwords.replan_owner,
    REPLAN_RUNTIME_PASSWORD: passwords.replan_runtime,
    INVENTORY_DATABASE_PASSWORD: passwords.inventory_owner,
    CARRIER_DATABASE_PASSWORD: passwords.carrier_owner,
    ...overrides,
  };
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'deploy/railway-bootstrap.mts'], {
    env: environment,
    encoding: 'utf8',
    timeout: 25_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const leaked = [adminPassword, ...Object.values(passwords), adminUrl.toString()].some((secret) =>
    output.includes(secret),
  );
  expect(leaked, 'Bootstrap output must not contain credentials or connection URLs').toBe(false);
  expect(output.includes('postgres://')).toBe(false);
  return { code: result.status, output };
}
async function targetCounts() {
  return (
    await admin!.query(
      `SELECT
    (SELECT count(*)::int FROM pg_roles WHERE rolname=ANY($1::text[])) AS roles,
    (SELECT count(*)::int FROM pg_database WHERE datname=ANY($2::text[])) AS databases`,
      [roleNames, databaseNames],
    )
  ).rows[0];
}

beforeAll(async () => {
  if (!/PostgreSQL\) 16\./.test(pgCommand('initdb', ['--version'])))
    throw new Error(
      'Bootstrap integration tests require PostgreSQL 16; set PG_BIN to its server bin directory.',
    );
  directory = await mkdtemp(join(tmpdir(), 'replan-bootstrap-test-'));
  const data = join(directory, 'data');
  pgCommand('initdb', [
    '-D',
    data,
    '-U',
    'bootstrap_admin',
    '--auth-local=trust',
    '--auth-host=trust',
    '--encoding=UTF8',
    '--no-locale',
  ]);
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  pgCommand('pg_ctl', [
    '-D',
    data,
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-p ${port} -h 127.0.0.1 -k ''`,
    '-w',
    'start',
  ]);
  running = true;
  adminUrl = new URL(`postgres://bootstrap_admin@127.0.0.1:${port}/postgres`);
  admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`ALTER ROLE bootstrap_admin PASSWORD ${pg.escapeLiteral(adminPassword)}`);
  await admin.end();
  admin = undefined;
  // Passwords remain in memory. Only the authentication policy goes to disk.
  await writeFile(
    join(data, 'pg_hba.conf'),
    'local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n',
    { mode: 0o600 },
  );
  pgCommand('pg_ctl', ['-D', data, 'reload']);
  adminUrl.password = adminPassword;
  admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  expect((await admin.query('SHOW data_directory')).rows[0].data_directory).toBe(data);
});

afterAll(async () => {
  try {
    await admin?.end();
  } finally {
    if (running) {
      pgCommand('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
      running = false;
    }
    if (directory && !running) await rm(directory, { recursive: true, force: true });
  }
});

describe('fresh Railway PostgreSQL bootstrap', () => {
  it('rejects missing, reused and short passwords before creating any targets', async () => {
    for (const overrides of [
      { REPLAN_OWNER_PASSWORD: '' },
      { REPLAN_RUNTIME_PASSWORD: 'short' },
      { CARRIER_DATABASE_PASSWORD: passwords.inventory_owner },
      { BOOTSTRAP_DATABASE_URL: 'postgres://private-password@invalid/inventory' },
    ]) {
      const result = invoke(overrides);
      expect(result.code).toBe(1);
      expect(result.output).toContain('configuration validation');
      expect(await targetCounts()).toEqual({ roles: 0, databases: 0 });
    }
  });

  it('preflights every target role and database before any persistent changes', async () => {
    await admin!.query('CREATE ROLE carrier_owner NOLOGIN');
    try {
      const result = invoke();
      expect(result.code).toBe(1);
      expect(result.output).toContain('fresh-cluster preflight');
      expect(await targetCounts()).toEqual({ roles: 1, databases: 0 });
      expect(
        (await admin!.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='carrier_owner'"))
          .rows[0].rolcanlogin,
      ).toBe(false);
    } finally {
      await admin!.query('DROP ROLE carrier_owner');
    }
    await admin!.query('CREATE DATABASE inventory');
    try {
      const result = invoke();
      expect(result.code).toBe(1);
      expect(result.output).toContain('fresh-cluster preflight');
      expect(await targetCounts()).toEqual({ roles: 0, databases: 1 });
      expect(
        (
          await admin!.query(
            "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='inventory'",
          )
        ).rows[0].owner,
      ).toBe('bootstrap_admin');
    } finally {
      await admin!.query('DROP DATABASE inventory');
    }
  });

  it('creates independent password-authenticated owners and a restricted runtime, then refuses rerun', async () => {
    const result = invoke();
    expect(result.code, result.output).toBe(0);
    expect(await targetCounts()).toEqual({ roles: 4, databases: 3 });
    const roles = await admin!.query(
      `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,
      rolreplication,rolbypassrls,rolpassword LIKE 'SCRAM-SHA-256$%' AS scram
      FROM pg_authid WHERE rolname=ANY($1::text[])`,
      [roleNames],
    );
    for (const role of roles.rows)
      expect(role).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        scram: true,
      });
    const ownership = (
      await admin!.query(
        `SELECT datname,pg_get_userbyid(datdba) AS owner
      FROM pg_database WHERE datname=ANY($1::text[]) ORDER BY datname`,
        [databaseNames],
      )
    ).rows;
    expect(ownership).toEqual([
      { datname: 'carrier', owner: 'carrier_owner' },
      { datname: 'inventory', owner: 'inventory_owner' },
      { datname: 'replan', owner: 'replan_owner' },
    ]);

    for (const role of roleNames as (keyof typeof passwords)[]) {
      const ownDatabase = role.startsWith('replan_') ? 'replan' : role.split('_')[0];
      const client = connection(role, ownDatabase);
      try {
        await client.connect();
        const identity = (
          await client.query('SELECT current_user AS current, session_user AS session')
        ).rows[0];
        expect(identity).toEqual({ current: role, session: role });
        if (role === 'replan_runtime') {
          expect(
            (await client.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0]
              .count,
          ).toBe(4);
          await client.query('UPDATE plans SET reason=reason WHERE false');
          for (const sql of [
            'CREATE TABLE denied(id integer)',
            'CREATE TEMP TABLE denied_temp(id integer)',
            "UPDATE operators SET role='admin' WHERE false",
            'SET ROLE replan_owner',
          ])
            await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
        } else if (role === 'replan_owner') {
          const owners = (
            await client.query(
              "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='public'",
            )
          ).rows;
          expect(owners).toEqual([{ tableowner: 'replan_owner' }]);
        } else {
          expect(
            (
              await client.query(
                "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'",
              )
            ).rows[0].count,
          ).toBe(0);
          await client.query('BEGIN; CREATE TABLE provider_can_initialize(id integer); ROLLBACK');
        }
      } finally {
        await client.end();
      }
      for (const foreign of databaseNames.filter((database) => database !== ownDatabase)) {
        const denied = connection(role, foreign);
        try {
          await expect(denied.connect()).rejects.toMatchObject({ code: '42501' });
        } finally {
          await denied.end();
        }
      }
    }
    const wrongPassword = connection('replan_runtime', 'replan', randomBytes(32).toString('hex'));
    try {
      await expect(wrongPassword.connect()).rejects.toMatchObject({ code: '28P01' });
    } finally {
      await wrongPassword.end();
    }
    const publicAccess = await admin!.query(
      `SELECT count(*)::int AS count FROM pg_database d,
      LATERAL aclexplode(d.datacl) acl WHERE d.datname=ANY($1::text[]) AND acl.grantee=0
      AND acl.privilege_type IN ('CONNECT','TEMPORARY')`,
      [databaseNames],
    );
    expect(publicAccess.rows[0].count).toBe(0);
    const before = (
      await admin!.query(
        'SELECT rolname,rolpassword FROM pg_authid WHERE rolname=ANY($1::text[]) ORDER BY rolname',
        [roleNames],
      )
    ).rows;
    const rerun = invoke();
    expect(rerun.code).toBe(1);
    expect(rerun.output).toContain('fresh-cluster preflight');
    const after = (
      await admin!.query(
        'SELECT rolname,rolpassword FROM pg_authid WHERE rolname=ANY($1::text[]) ORDER BY rolname',
        [roleNames],
      )
    ).rows;
    expect(
      JSON.stringify(before) === JSON.stringify(after),
      'A refused rerun must preserve password verifiers',
    ).toBe(true);
  });
});
