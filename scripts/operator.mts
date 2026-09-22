import { parseArgs } from 'node:util';
import { z } from 'zod';

const usage = `Provision one person in an existing workspace:
  npm run operator -- create --name "Jane Doe" --role operator --workspace <workspace-uuid>
  npm run operator -- rotate --id <operator-uuid>
  npm run operator -- revoke --id <operator-uuid>

Roles: admin, operator, viewer. Set DATABASE_URL to the intended application database.
Create and rotate print the new secret key once. Deliver it privately to that person;
never paste it into a ticket, commit, shell history, or a shared terminal recording.
Rotation invalidates the old key and all sessions. Revoke disables the person permanently.
`;

let close: (() => Promise<void>) | undefined;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      name: { type: 'string' },
      role: { type: 'string' },
      workspace: { type: 'string' },
      id: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    if (positionals.length !== 1 || !['create', 'rotate', 'revoke'].includes(positionals[0]))
      throw new Error('Specify exactly one command: create, rotate, or revoke.');
    const command = positionals[0];
    if (command === 'create') {
      if (values.id) throw new Error('Create does not accept --id.');
      z.object({
        name: z.string().min(1),
        role: z.enum(['admin', 'operator', 'viewer']),
        workspace: z.uuid(),
      }).parse(values);
    } else {
      if (values.name || values.role || values.workspace)
        throw new Error('Rotate and revoke only accept --id.');
      z.uuid().parse(values.id);
    }
    const { pool, migrate } = await import('../src/db.js');
    const { provisionOperator, rotateOperatorKey, revokeOperator } = await import('../src/auth.js');
    close = () => pool.end();
    await migrate();
    if (command === 'create') {
      const result = await provisionOperator(pool, {
        name: values.name!,
        role: values.role as 'admin' | 'operator' | 'viewer',
        workspaceId: values.workspace!,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (command === 'rotate') {
      process.stdout.write(
        `${JSON.stringify(await rotateOperatorKey(pool, values.id!), null, 2)}\n`,
      );
    } else {
      await revokeOperator(pool, values.id!);
      process.stdout.write(
        'Operator revoked; its access key and sessions no longer authenticate.\n',
      );
    }
  }
} catch (error) {
  // Do not print raw database/driver errors: they can contain connection details.
  const message =
    error instanceof z.ZodError
      ? 'Invalid or missing arguments. Use --help for usage.'
      : error instanceof Error && !('code' in error)
        ? error.message
        : 'Operator command failed. Check the database, workspace, and arguments.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await close?.();
}
