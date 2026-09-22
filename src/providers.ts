import { z } from 'zod';
import { config } from './config.js';
import type { Reservation, Shipment, Stock } from '../shared/contracts.js';

export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message);
  }
}

const identifier = z.string().min(1).max(160);
const scenarioId = z.uuid();
const quantity = z.number().int().min(1).max(1_000_000);
const version = z.number().int().min(0).max(2_000_000_000);
const stockSchema: z.ZodType<Stock> = z.strictObject({
  warehouse: identifier,
  part: identifier,
  available: z.number().int().min(0).max(1_000_000),
  version,
});
const reservationSchema: z.ZodType<Reservation> = z.strictObject({
  key: identifier,
  scenarioId,
  warehouse: identifier,
  part: identifier,
  quantity,
  version,
  status: z.enum(['held', 'consumed', 'released']),
});
const shipmentSchema: z.ZodType<Shipment> = z.strictObject({
  key: identifier,
  scenarioId,
  orderId: identifier,
  warehouse: identifier,
  quantity,
  laneId: identifier,
  cost: z.number().nonnegative().max(1_000_000_000),
  status: z.literal('dispatched'),
  createdAt: z.iso.datetime({ offset: true }),
});
const inventoryStateSchema = z
  .strictObject({
    stock: z.array(stockSchema).max(500),
    reservations: z.array(reservationSchema).max(10_000),
  })
  .refine(
    ({ stock, reservations }) =>
      new Set(stock.map((item) => JSON.stringify([item.warehouse, item.part]))).size ===
        stock.length && new Set(reservations.map((item) => item.key)).size === reservations.length,
    { message: 'Provider state contains duplicate records' },
  );
const carrierStateSchema = z
  .strictObject({
    shipments: z.array(shipmentSchema).max(10_000),
    lookupAvailable: z.boolean(),
  })
  .refine(
    ({ shipments }) =>
      new Set(shipments.map((item) => item.key)).size === shipments.length &&
      new Set(shipments.map((item) => item.orderId)).size === shipments.length,
    { message: 'Provider state contains duplicate commitments' },
  );
const inventoryCancellationSchema = z
  .strictObject({
    outcome: z.literal('cancelled'),
    key: identifier,
    scenarioId,
    reservation: reservationSchema.nullable(),
  })
  .refine(
    ({ key, scenarioId: scope, reservation }) =>
      reservation === null ||
      (reservation.status === 'released' &&
        reservation.key === key &&
        reservation.scenarioId === scope),
    { message: 'Cancellation must describe the released reservation' },
  );
const carrierCancellationSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('cancelled'), key: identifier, scenarioId }),
  z.strictObject({ outcome: z.literal('dispatched'), shipment: shipmentSchema }),
]);
const healthSchema = z.strictObject({ ok: z.literal(true) });
export type InventoryCancellation = z.infer<typeof inventoryCancellationSchema>;
export type CarrierCancellation = z.infer<typeof carrierCancellationSchema>;

const responseLimit = 1024 * 1024;
async function readResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > responseLimit) {
    await response.body?.cancel();
    throw new Error('Response is too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > responseLimit) {
        await reader.cancel();
        throw new Error('Response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

/** A transport/contract failure is unknown, even when HTTP headers were received.
 * The caller must reconcile; this boundary never retries an external effect.
 */
export async function request<T = unknown>(
  base: string,
  path: string,
  body?: unknown,
  schema?: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  let data: unknown;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (config.providerToken) headers.authorization = `Bearer ${config.providerToken}`;
    response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.providerTimeoutMs),
      redirect: 'error',
    });
    data = await readResponse(response);
  } catch {
    throw new ProviderError(
      'Provider response unavailable or invalid; outcome must be reconciled.',
      null,
    );
  }
  if (!response.ok) {
    const failure = z.object({ error: z.string().max(4_096) }).safeParse(data);
    if (!failure.success)
      throw new ProviderError('Invalid provider error response; outcome must be reconciled.', null);
    throw new ProviderError(failure.data.error, response.status);
  }
  if (schema) {
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ProviderError(
        'Provider response violates its contract; outcome must be reconciled.',
        null,
      );
    return parsed.data;
  }
  return data as T;
}
export async function lookup<T>(
  base: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    return await request(base, path, undefined, schema);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return null;
    throw error;
  }
}
export const inventory = {
  health: () => request(config.inventoryUrl, '/health', undefined, healthSchema),
  state: (id: string) =>
    request(
      config.inventoryUrl,
      `/scenarios/${encodeURIComponent(id)}`,
      undefined,
      inventoryStateSchema,
    ),
  find: (key: string) =>
    lookup(config.inventoryUrl, `/reservations/${encodeURIComponent(key)}`, reservationSchema),
  reserve: (body: {
    key: string;
    scenarioId: string;
    warehouse: string;
    part: string;
    quantity: number;
    expectedVersion: number;
  }) => request(config.inventoryUrl, '/reservations', body, reservationSchema),
  consume: (key: string) =>
    request(
      config.inventoryUrl,
      `/reservations/${encodeURIComponent(key)}/consume`,
      {},
      reservationSchema,
    ),
  release: (key: string) =>
    request(
      config.inventoryUrl,
      `/reservations/${encodeURIComponent(key)}/release`,
      {},
      reservationSchema,
    ),
  cancel: (key: string, scenarioId: string, reason: string) =>
    request(
      config.inventoryUrl,
      `/reservations/${encodeURIComponent(key)}/cancel`,
      { scenarioId, reason },
      inventoryCancellationSchema,
    ),
};
export const carrier = {
  health: () => request(config.carrierUrl, '/health', undefined, healthSchema),
  state: (id: string) =>
    request(
      config.carrierUrl,
      `/scenarios/${encodeURIComponent(id)}`,
      undefined,
      carrierStateSchema,
    ),
  find: (key: string, scenarioId: string) =>
    lookup(
      config.carrierUrl,
      `/shipments/${encodeURIComponent(key)}?scenarioId=${encodeURIComponent(scenarioId)}`,
      shipmentSchema,
    ),
  dispatch: (body: Omit<Shipment, 'createdAt' | 'status'>) =>
    request(config.carrierUrl, '/shipments', body, shipmentSchema),
  cancel: (key: string, scenarioId: string, reason: string) =>
    request(
      config.carrierUrl,
      `/shipments/${encodeURIComponent(key)}/cancel`,
      { scenarioId, reason },
      carrierCancellationSchema,
    ),
};
