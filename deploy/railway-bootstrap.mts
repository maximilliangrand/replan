import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const passwords = {
  replan_owner: 'REPLAN_OWNER_PASSWORD',
  replan_runtime: 'REPLAN_RUNTIME_PASSWORD',
  inventory_owner: 'INVENTORY_DATABASE_PASSWORD',
  carrier_owner: 'CARRIER_DATABASE_PASSWORD',
} as const;
const databases = [
  { name: 'replan', owner: 'replan_owner', clients: ['replan_owner', 'replan_runtime'] },
  { name: 'inventory', owner: 'inventory_owner', clients: ['inventory_owner'] },
  { name: 'carrier', owner: 'carrier_owner', clients: ['carrier_owner'] },
] as const;

function roleUrl(base: URL, role: string, password: string, database: string) {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  // A bootstrap connection's SET ROLE/search_path options must not carry over.
  url.searchParams.delete('options');
  return url.toString();
}

/** Fresh install only. CREATE DATABASE is not transactional; a failed partial
 * install is deliberately left for administrative inspection, never reset or retried. */
export async function bootstrap(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let stage = 'configuration validation';
  let admin: pg.Client | undefined;
  let owner: pg.Client | undefined;
  try {
    const input = environment.BOOTSTRAP_DATABASE_URL;
    if (!input) throw new Error();
    const url = new URL(input);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/postgres')
      throw new Error();
    const secrets = Object.fromEntries(
      Object.entries(passwords).map(([role, name]) => {
        const password = environment[name];
        if (
          !password ||
          password.length < 32 ||
          password.length > 1024 ||
          /[\u0000-\u001f\u007f]/.test(password)
        )
          throw new Error();
        return [role, password];
      }),
    );
    if (new Set(Object.values(secrets)).size !== Object.keys(passwords).length) throw new Error();
    // Read required local input before allocating anything in PostgreSQL.
    const grants = await readFile(new URL('./runtime-grants.sql', import.meta.url), 'utf8');
    stage = 'fresh-cluster preflight';
    admin = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10_000 });
    await admin.connect();
    const server = (
      await admin.query(`SELECT current_database() AS database,
      current_setting('server_version_num')::int AS version,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)
    ).rows[0];
    if (
      server.database !== 'postgres' ||
      server.version < 160000 ||
      server.version >= 170000 ||
      !server.superuser
    )
      throw new Error();
    const lock = (await admin.query('SELECT pg_try_advisory_lock(782019, 42) AS locked')).rows[0]
      .locked;
    if (!lock) throw new Error();
    const existing = await admin.query(
      `SELECT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname=ANY($1::text[])
      UNION ALL SELECT 1 FROM pg_database WHERE datname=ANY($2::text[])
    ) AS conflict`,
      [Object.keys(passwords), databases.map((database) => database.name)],
    );
    if (existing.rows[0].conflict) throw new Error();

    stage = 'role creation';
    await admin.query('BEGIN');
    try {
      await admin.query("SET LOCAL password_encryption='scram-sha-256'");
      for (const role of Object.keys(passwords))
        await admin.query(
          `CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(secrets[role])}`,
        );
      await admin.query('COMMIT');
    } catch {
      await admin.query('ROLLBACK');
      throw new Error();
    }
    stage = 'database creation and connection grants';
    for (const database of databases) {
      const name = pg.escapeIdentifier(database.name);
      await admin.query(
        `CREATE DATABASE ${name} OWNER ${pg.escapeIdentifier(database.owner)} TEMPLATE template0 ALLOW_CONNECTIONS false`,
      );
      await admin.query(`REVOKE CONNECT,TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${name} TO ${database.clients.map(pg.escapeIdentifier).join(',')}`,
      );
      await admin.query(`ALTER DATABASE ${name} ALLOW_CONNECTIONS true`);
    }

    stage = 'application migration';
    const ownerUrl = roleUrl(url, 'replan_owner', secrets.replan_owner, 'replan');
    const env: NodeJS.ProcessEnv = {
      ...environment,
      DATABASE_URL: ownerUrl,
      REPLAN_MODE: 'demo',
      NODE_ENV: 'test',
    };
    for (const name of ['BOOTSTRAP_DATABASE_URL', ...Object.values(passwords)]) delete env[name];
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/migrate.mts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env,
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    try {
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error();
    } finally {
      clearTimeout(timeout);
    }

    stage = 'application runtime grants';
    owner = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 10_000 });
    await owner.connect();
    if ((await owner.query('SELECT current_user AS name')).rows[0].name !== 'replan_owner')
      throw new Error();
    await owner.query(grants);
  } catch {
    // Never propagate PostgreSQL, URL-parser or child-process errors: they may
    // contain connection strings, SQL statements or credentials.
    throw new Error(
      `Bootstrap stopped during ${stage}. No automatic reset or retry was performed; inspect the dedicated cluster before proceeding.`,
    );
  } finally {
    // Closing the admin session also releases the bootstrap advisory lock.
    const closed = await Promise.allSettled([owner?.end(), admin?.end()]);
    if (closed.some((result) => result.status === 'rejected'))
      throw new Error(
        'Bootstrap connection cleanup failed; inspect the dedicated cluster before proceeding.',
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error('Bootstrap accepts configuration only through the environment.');
    process.exitCode = 1;
  } else {
    bootstrap()
      .then(() =>
        console.log(
          'Fresh PostgreSQL16 bootstrap completed: isolated database roles, application migrations, and runtime grants applied.',
        ),
      )
      .catch((error) => {
        console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
        process.exitCode = 1;
      });
  }
}
