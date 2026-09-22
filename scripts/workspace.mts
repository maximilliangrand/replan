import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const usage = `Create an isolated workspace; this does not create provider data or start an operation:
  npm run workspace -- create --name "Factory pilot"

Bind an already provisioned provider dataset to its one workspace:
  npm run workspace -- assign --id <workspace-uuid> --scenario <scenario-uuid> --source "Import reference"

Set DATABASE_URL to the intended application database. Assignment is immutable:
an existing scenario cannot be reassigned, even to the same workspace.
`;
let close: (() => Promise<void>) | undefined;
try {
  const { values, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      id: { type: 'string' },
      scenario: { type: 'string' },
      source: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) process.stdout.write(usage);
  else {
    if (positionals.length !== 1 || !['create', 'assign'].includes(positionals[0]))
      throw new Error('Specify exactly one command: create or assign.');
    const command = positionals[0];
    const text = (maximum: number) =>
      z
        .string()
        .trim()
        .min(1)
        .max(maximum)
        .regex(/^[^\u0000-\u001f\u007f]+$/);
    const input =
      command === 'create'
        ? z
            .object({ name: text(120) })
            .strict()
            .parse(values)
        : z
            .object({ id: z.uuid(), scenario: z.uuid(), source: text(500) })
            .strict()
            .parse(values);
    const { pool, migrate } = await import('../src/db.js');
    close = () => pool.end();
    await migrate();
    if ('name' in input) {
      const id = randomUUID();
      await pool.query('INSERT INTO workspaces(id,name) VALUES($1,$2)', [id, input.name]);
      process.stdout.write(`${JSON.stringify({ id, name: input.name }, null, 2)}\n`);
    } else {
      await pool.query(
        'INSERT INTO operation_sources(scenario_id,workspace_id,source) VALUES($1,$2,$3)',
        [input.scenario, input.id, input.source],
      );
      process.stdout.write(
        'Provider dataset assigned to the workspace. No operation was imported or executed.\n',
      );
    }
  }
} catch (error) {
  const message =
    error instanceof z.ZodError
      ? 'Invalid or missing arguments. Use --help for usage.'
      : error instanceof Error && 'code' in error && error.code === '23505'
        ? 'This provider dataset is already assigned. Assignment cannot be overwritten.'
        : error instanceof Error && !('code' in error)
          ? error.message
          : 'Workspace command failed. Check the database, workspace, and migration state.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await close?.();
}
