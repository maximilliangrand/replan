import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, test as base, expect, type BrowserContext } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { provisionOperator, rotateOperatorKey } from '../src/auth.js';
import { makeScenario } from '../src/scenario.js';
import { createInventory } from '../src/simulators/inventory.js';
import { createCarrier } from '../src/simulators/carrier.js';

const exec = promisify(execFile);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function stop(child?: ChildProcess) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

export class Pilot {
  readonly adminUrl = new URL(
    process.env.TEST_DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan_test',
  );
  readonly admin = new pg.Pool({ connectionString: this.adminUrl.toString() });
  readonly suffix = randomBytes(8).toString('hex');
  readonly names = ['app', 'inventory', 'carrier'].map(
    (kind) => `replan_browser_${kind}_${this.suffix}_test`,
  );
  readonly created: string[] = [];
  readonly workspace = randomUUID();
  readonly logs: string[] = [];
  readonly secrets: string[] = [];
  private directory = '';
  private app?: ChildProcess;
  private caddy?: ChildProcess;
  private appPort = 0;
  private inventory?: FastifyInstance;
  private carrier?: FastifyInstance;
  private inventoryUrl = '';
  private carrierUrl = '';
  private providerToken = randomBytes(32).toString('hex');
  private configuredToken = this.providerToken;
  private runtimeRole = `browser_runtime_${this.suffix}`;
  private roleCreated = false;
  db!: pg.Pool;
  origin = '';
  certificate = '';
  spki = '';
  operator!: Awaited<ReturnType<typeof provisionOperator>>;
  viewer!: Awaited<ReturnType<typeof provisionOperator>>;
  scenario = makeScenario();

  private databaseUrl(index: number) {
    const url = new URL(this.adminUrl);
    url.pathname = `/${this.names[index]}`;
    return url;
  }
  private process(command: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(command, args, {
      env: { ...process.env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk) => this.logs.push(String(chunk)));
    child.on('error', () => this.logs.push('Service spawn failed.'));
    return child;
  }
  async setup() {
    if (!this.adminUrl.pathname.endsWith('_test'))
      throw new Error('Browser tests require a dedicated *_test administrator database.');
    this.directory = await mkdtemp(join(tmpdir(), 'replan-browser-'));
    for (const name of this.names) {
      await this.admin.query(`CREATE DATABASE "${name}"`);
      this.created.push(name);
    }
    const databaseUrl = this.databaseUrl(0).toString();
    this.db = new pg.Pool({ connectionString: databaseUrl });
    await exec(process.execPath, ['--import', 'tsx', 'scripts/migrate.mts'], {
      env: { ...process.env, NODE_ENV: 'test', REPLAN_MODE: 'demo', DATABASE_URL: databaseUrl },
      timeout: 15000,
    });
    await this.db.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [
      this.workspace,
      'Browser acceptance fixture',
    ]);
    this.operator = await provisionOperator(this.db, {
      workspaceId: this.workspace,
      name: 'Pilot operator',
      role: 'operator',
    });
    this.viewer = await provisionOperator(this.db, {
      workspaceId: this.workspace,
      name: 'Pilot reviewer',
      role: 'viewer',
    });
    this.secrets.push(this.operator.key, this.viewer.key, this.providerToken);
    // Use the same restricted SQL grants as the deployment recipe.
    await this.db.query(
      `CREATE ROLE "${this.runtimeRole}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    this.roleCreated = true;
    const grants = (await readFile('deploy/runtime-grants.sql', 'utf8'))
      .replaceAll(/\breplan_runtime\b/g, `"${this.runtimeRole}"`)
      .replace(
        /GRANT CONNECT ON DATABASE replan\b/,
        `GRANT CONNECT ON DATABASE "${this.names[0]}"`,
      );
    await this.db.query(grants);
    await this.startProviders();
    const { scenario, stock } = this.scenario;
    await this.inventory!.inject({
      method: 'POST',
      url: '/scenarios',
      headers: { authorization: `Bearer ${this.providerToken}` },
      payload: { scenarioId: scenario.id, stock },
    });
    await this.carrier!.inject({
      method: 'POST',
      url: '/scenarios',
      headers: { authorization: `Bearer ${this.providerToken}` },
      payload: { scenarioId: scenario.id },
    });
    await this.db.query(
      'INSERT INTO operation_sources(scenario_id,workspace_id,source) VALUES($1,$2,$3)',
      [scenario.id, this.workspace, 'Synthetic browser acceptance fixture'],
    );
    // Seeding fixture data is administration, not an unreviewed provider action.
    await this.db.query(
      'INSERT INTO scenario_state(workspace_id,scenario,snapshot) VALUES($1,$2,$3)',
      [this.workspace, scenario, { observedAt: new Date().toISOString(), stock }],
    );
    await this.db.query(
      "INSERT INTO events(scenario_id,workspace_id,kind,message,data) VALUES($1,$2,'scenario.started','Synthetic HTTPS browser fixture',$3)",
      [scenario.id, this.workspace, { scenario, stock }],
    );
    this.appPort = await freePort();
    const tlsPort = await freePort();
    this.origin = `https://127.0.0.1:${tlsPort}`;
    const certificate = join(this.directory, 'certificate.pem');
    const key = join(this.directory, 'key.pem');
    const opensslConfig = join(this.directory, 'openssl.cnf');
    await writeFile(
      opensslConfig,
      '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
      { mode: 0o600 },
    );
    await exec(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        opensslConfig,
        '-keyout',
        key,
        '-out',
        certificate,
      ],
      { timeout: 15000 },
    );
    this.certificate = await readFile(certificate, 'utf8');
    this.spki = createHash('sha256')
      .update(
        new X509Certificate(this.certificate).publicKey.export({ format: 'der', type: 'spki' }),
      )
      .digest('base64');
    // Use production ingress headers and IP rules, with only loopback routing and
    // a short-lived fixture certificate substituted. Never install a system CA.
    const caddyfile = (await readFile('deploy/Caddyfile', 'utf8'))
      .replace('email {$ACME_EMAIL}', 'auto_https off')
      .replace('{$APP_DOMAIN}', this.origin)
      .replace('{$PILOT_ALLOWED_CIDRS}', '127.0.0.1/32')
      .replace(
        'reverse_proxy replan:4310',
        `tls "${certificate}" "${key}"\n\treverse_proxy 127.0.0.1:${this.appPort}`,
      );
    const config = join(this.directory, 'Caddyfile');
    await writeFile(config, caddyfile, { mode: 0o600 });
    await this.startApp();
    this.caddy = this.process(
      process.env.CADDY_BIN ?? resolve('.local/validation/caddy/caddy'),
      ['run', '--config', config, '--adapter', 'caddyfile'],
      { XDG_DATA_HOME: this.directory, XDG_CONFIG_HOME: this.directory },
    );
    for (let i = 0; i < 100; i++) {
      try {
        if ((await this.api('/ready')).status === 200) return;
      } catch {
        /* start */
      }
      await wait(50);
    }
    throw new Error('Local HTTPS ingress did not become ready.');
  }
  private async startProviders() {
    this.inventory = await createInventory(this.databaseUrl(1).toString(), {
      token: this.providerToken,
    });
    this.carrier = await createCarrier(this.databaseUrl(2).toString(), {
      token: this.providerToken,
    });
    this.inventoryUrl = await this.inventory.listen({ host: '127.0.0.1', port: 0 });
    this.carrierUrl = await this.carrier.listen({ host: '127.0.0.1', port: 0 });
  }
  private async startApp() {
    const url = this.databaseUrl(0);
    url.searchParams.set('options', `-c role=${this.runtimeRole}`);
    this.app = this.process(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      REPLAN_MODE: 'pilot',
      NODE_ENV: 'production',
      APP_ORIGIN: this.origin,
      HOST: '127.0.0.1',
      PORT: String(this.appPort),
      DATABASE_URL: url.toString(),
      MIGRATE_ON_START: 'false',
      INVENTORY_URL: this.inventoryUrl,
      CARRIER_URL: this.carrierUrl,
      PROVIDER_TOKEN: this.configuredToken,
      LOG_LEVEL: 'info',
    });
    for (let i = 0; i < 100; i++) {
      if (this.app.exitCode !== null) throw new Error('Pilot app exited during startup.');
      const ready = await new Promise<boolean>((resolve) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: this.appPort,
            path: '/api/health',
            headers: { host: new URL(this.origin).host },
            signal: AbortSignal.timeout(1000),
            agent: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode === 200);
          },
        );
        req.on('error', () => resolve(false));
        req.end();
      });
      if (ready) return;
      await wait(50);
    }
    throw new Error('Pilot app did not become healthy.');
  }
  api(path: string, key?: string, body?: unknown) {
    return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const req = httpsRequest(
        this.origin + '/api' + path,
        {
          ca: this.certificate,
          agent: false,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            'content-type': 'application/json',
          },
          signal: AbortSignal.timeout(5000),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode!,
                data: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch {
              reject(new Error('Unreadable pilot response'));
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async loseResponse() {
    const result = await this.carrier!.inject({
      method: 'POST',
      url: `/scenarios/${this.scenario.scenario.id}/fault`,
      headers: { authorization: `Bearer ${this.providerToken}` },
      payload: { fault: 'lost_response' },
    });
    expect(result.statusCode).toBe(200);
  }
  async rotateOperator() {
    const rotated = await rotateOperatorKey(this.db, this.operator.principal.id);
    this.secrets.push(rotated.key);
    this.operator = rotated;
  }
  async rotateProviderOnly() {
    await stop(this.app);
    await Promise.all([this.inventory!.close(), this.carrier!.close()]);
    this.providerToken = randomBytes(32).toString('hex');
    this.secrets.push(this.providerToken);
    await this.startProviders();
    // Rebind URLs after restart but deliberately retain the old app token.
    await stop(this.app);
    await this.startApp();
  }
  async reconnectProvider() {
    this.configuredToken = this.providerToken;
    await stop(this.app);
    await this.startApp();
  }
  async cleanup() {
    const failures: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        failures.push(label);
      }
    };
    await Promise.all([
      attempt('ingress process', () => stop(this.caddy)),
      attempt('application process', () => stop(this.app)),
    ]);
    await Promise.all([
      attempt('inventory service', async () => {
        await this.inventory?.close();
      }),
      attempt('carrier service', async () => {
        await this.carrier?.close();
      }),
    ]);
    if (this.db) {
      if (this.roleCreated)
        await attempt('runtime grants', () => this.db.query(`DROP OWNED BY "${this.runtimeRole}"`));
      await attempt('application database pool', () => this.db.end());
    }
    for (const name of this.created)
      await attempt(`temporary database ${name}`, () =>
        this.admin.query(`DROP DATABASE "${name}"`),
      );
    if (this.roleCreated)
      await attempt('runtime role', () => this.admin.query(`DROP ROLE "${this.runtimeRole}"`));
    await attempt('administrator pool', () => this.admin.end());
    if (this.directory)
      await attempt('temporary certificates', () =>
        rm(this.directory, { recursive: true, force: true }),
      );
    if (failures.length)
      throw new Error(`Browser fixture cleanup failed for: ${failures.join(', ')}`);
  }
  assertLogsRedacted() {
    const logs = this.logs.join('');
    for (const secret of this.secrets)
      expect(logs.includes(secret), 'Credentials must not appear in logs').toBe(false);
    expect(/rps_[A-Za-z0-9_-]{43}/.test(logs), 'Session secrets must not appear in logs').toBe(
      false,
    );
  }
}

export const test = base.extend<{ pilot: Pilot }>({
  pilot: async ({}, use) => {
    const pilot = new Pilot();
    try {
      await pilot.setup();
      await use(pilot);
      pilot.assertLogsRedacted();
    } finally {
      await pilot.cleanup();
    }
  },
  page: async ({ pilot }, use) => {
    const browser = await chromium.launch({
      args: [`--ignore-certificate-errors-spki-list=${pilot.spki}`],
    });
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        ignoreHTTPSErrors: false,
      });
      await use(await context.newPage());
    } finally {
      try {
        await context?.close();
      } finally {
        await browser.close();
      }
    }
  },
});
