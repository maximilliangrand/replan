// The optional Compose profile must never fall back to a developer database.
const kind = process.argv[2];
if (kind !== 'inventory' && kind !== 'carrier') throw new Error('Select inventory or carrier.');
const variable = kind === 'inventory' ? 'INVENTORY_DATABASE_URL' : 'CARRIER_DATABASE_URL';
if (!process.env[variable]) throw new Error(`Simulation validation requires ${variable}.`);
if ((process.env.SIMULATOR_TOKEN?.length ?? 0) < 32)
  throw new Error('Simulation validation requires a service credential of at least 32 characters.');
await import('../src/simulators/server.js');
