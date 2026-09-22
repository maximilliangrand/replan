export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://replan@127.0.0.1:55432/replan',
  inventoryUrl: process.env.INVENTORY_URL ?? 'http://127.0.0.1:4311',
  carrierUrl: process.env.CARRIER_URL ?? 'http://127.0.0.1:4312',
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 4310),
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS ?? 2000),
};
