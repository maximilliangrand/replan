import { createInventory } from './inventory.js';
import { createCarrier } from './carrier.js';

const kind = process.argv[2];
if (kind !== 'inventory' && kind !== 'carrier')
  throw new Error('Usage: tsx src/simulators/server.ts inventory|carrier');
const inventory = kind === 'inventory';
const token = process.env.SIMULATOR_TOKEN;
const allowedHostname = process.env.SIMULATOR_HOSTNAME;
if (process.env.REPLAN_MODE === 'pilot' && !token)
  throw new Error('SIMULATOR_TOKEN is required in pilot mode');
const databaseURL = inventory
  ? (process.env.INVENTORY_DATABASE_URL ?? 'postgresql://replan@127.0.0.1:55432/replan_inventory')
  : (process.env.CARRIER_DATABASE_URL ?? 'postgresql://replan@127.0.0.1:55432/replan_carrier');
const app = await (inventory
  ? createInventory(databaseURL, { token, allowedHostname })
  : createCarrier(databaseURL, { token, allowedHostname }));
const port = Number(
  inventory ? (process.env.INVENTORY_PORT ?? 4311) : (process.env.CARRIER_PORT ?? 4312),
);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
console.log(`Replan ${kind} simulator listening on port ${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
