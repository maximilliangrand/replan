// Intentionally separate from service startup so deployment can use a DDL role
// while the long-running application receives only runtime privileges.
let close: (() => Promise<void>) | undefined;
try {
  const { migrate, pool } = await import('../src/db.js');
  close = () => pool.end();
  await migrate();
  process.stdout.write('Application schema is current; migration checksums verified.\n');
} catch {
  process.stderr.write(
    'Migration failed. Check the database access and migration history; do not edit applied migrations.\n',
  );
  process.exitCode = 1;
} finally {
  await close?.();
}
