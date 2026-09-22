import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { carrier, inventory, request } from '../src/providers.js';

const scenarioId = randomUUID();
const reservation = {
  key: 'action-1',
  scenarioId,
  warehouse: 'Vienna',
  part: 'BRG-42',
  quantity: 4,
  version: 2,
  status: 'held' as const,
};
const shipment = {
  key: 'action-1',
  scenarioId,
  orderId: 'repair-001',
  warehouse: 'Vienna',
  quantity: 4,
  laneId: 'truck-vienna',
  cost: 320,
  status: 'dispatched' as const,
  createdAt: '2026-09-22T10:00:00.000Z',
};
const stock = { warehouse: 'Vienna', part: 'BRG-42', available: 2, version: 2 };
const reserveBody = {
  key: reservation.key,
  scenarioId,
  warehouse: reservation.warehouse,
  part: reservation.part,
  quantity: 4,
  expectedVersion: 1,
};
const originalToken = config.providerToken;
const originalTimeout = config.providerTimeoutMs;

afterEach(() => {
  config.providerToken = originalToken;
  config.providerTimeoutMs = originalTimeout;
  vi.unstubAllGlobals();
});

function respond(data: unknown, status = 200) {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const contracts = [
  {
    name: 'inventory state',
    call: () => inventory.state(scenarioId),
    valid: { stock: [stock], reservations: [reservation] },
    invalid: { stock: [{ ...stock, available: -1 }], reservations: [] },
  },
  {
    name: 'inventory lookup',
    call: () => inventory.find('action-1'),
    valid: reservation,
    invalid: { ...reservation, quantity: '4' },
  },
  {
    name: 'reservation creation',
    call: () => inventory.reserve(reserveBody),
    valid: reservation,
    invalid: { ...reservation, version: -1 },
  },
  {
    name: 'consumption',
    call: () => inventory.consume('action-1'),
    valid: { ...reservation, status: 'consumed' },
    invalid: { ...reservation, status: 'unknown' },
  },
  {
    name: 'release',
    call: () => inventory.release('action-1'),
    valid: { ...reservation, status: 'released' },
    invalid: { ...reservation, override: true },
  },
  {
    name: 'inventory cancellation',
    call: () => inventory.cancel('action-1', scenarioId, 'Stop'),
    valid: {
      outcome: 'cancelled',
      key: 'action-1',
      scenarioId,
      reservation: { ...reservation, status: 'released' },
    },
    invalid: { outcome: 'cancelled', key: 'action-1', scenarioId, reservation },
  },
  {
    name: 'carrier state',
    call: () => carrier.state(scenarioId),
    valid: { shipments: [shipment], lookupAvailable: true },
    invalid: { shipments: [shipment], lookupAvailable: 'true' },
  },
  {
    name: 'carrier lookup',
    call: () => carrier.find('action-1', scenarioId),
    valid: shipment,
    invalid: { ...shipment, createdAt: 'yesterday' },
  },
  {
    name: 'dispatch',
    call: () =>
      carrier.dispatch({
        key: 'action-1',
        scenarioId,
        orderId: 'repair-001',
        warehouse: 'Vienna',
        quantity: 4,
        laneId: 'truck-vienna',
        cost: 320,
      }),
    valid: shipment,
    invalid: { ...shipment, cost: -100 },
  },
  {
    name: 'carrier cancellation',
    call: () => carrier.cancel('action-1', scenarioId, 'Stop'),
    valid: { outcome: 'cancelled', key: 'action-1', scenarioId },
    invalid: { outcome: 'cancelled' },
  },
  {
    name: 'inventory readiness',
    call: () => inventory.health(),
    valid: { ok: true },
    invalid: { ok: false },
  },
  {
    name: 'carrier readiness',
    call: () => carrier.health(),
    valid: { ok: true },
    invalid: { ok: 'yes' },
  },
];

describe('strict provider contracts', () => {
  it.each(contracts)('validates $name', async ({ call, valid, invalid }) => {
    respond(valid);
    expect(await call()).toEqual(valid);
    const invalidResponse = respond(invalid);
    await expect(call()).rejects.toMatchObject({ status: null });
    expect(invalidResponse).toHaveBeenCalledTimes(1);
  });

  it('accepts a carrier commitment and an absent inventory tombstone as distinct cancellation results', async () => {
    respond({ outcome: 'dispatched', shipment });
    expect(await carrier.cancel('action-1', scenarioId, 'Stop')).toEqual({
      outcome: 'dispatched',
      shipment,
    });
    respond({ outcome: 'cancelled', key: 'action-1', scenarioId, reservation: null });
    expect(await inventory.cancel('action-1', scenarioId, 'Stop')).toEqual({
      outcome: 'cancelled',
      key: 'action-1',
      scenarioId,
      reservation: null,
    });
  });

  it('rejects contradictory cancellation evidence and duplicate records', async () => {
    for (const replacement of [
      { ...reservation, key: 'other', status: 'released' },
      { ...reservation, scenarioId: randomUUID(), status: 'released' },
    ]) {
      respond({ outcome: 'cancelled', key: 'action-1', scenarioId, reservation: replacement });
      await expect(inventory.cancel('action-1', scenarioId, 'Stop')).rejects.toMatchObject({
        status: null,
      });
    }
    respond({ stock: [stock, stock], reservations: [] });
    await expect(inventory.state(scenarioId)).rejects.toMatchObject({ status: null });
    respond({
      shipments: [shipment, { ...shipment, key: 'different-key' }],
      lookupAvailable: true,
    });
    await expect(carrier.state(scenarioId)).rejects.toMatchObject({ status: null });
  });

  it('uses explicit 404 absence only for valid error responses, never malformed replies', async () => {
    respond({ error: 'Not found' }, 404);
    expect(await carrier.find('absent', scenarioId)).toBe(null);
    expect(await inventory.find('absent')).toBe(null);
    respond({ unrelated: 'Not found' }, 404);
    await expect(carrier.find('absent', scenarioId)).rejects.toMatchObject({ status: null });
    respond({ error: 'Provider is temporarily unavailable' }, 503);
    await expect(inventory.find('absent')).rejects.toMatchObject({ status: 503 });
  });

  it.each([200, 404, 409, 503])(
    'treats invalid JSON with HTTP %i as an unknown outcome without retry',
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{broken', { status }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(carrier.cancel('action-1', scenarioId, 'Stop')).rejects.toMatchObject({
        status: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds declared and streamed response sizes to one MiB', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-length': '1048577' } })),
    );
    await expect(inventory.state(scenarioId)).rejects.toMatchObject({ status: null });
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(128 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
    );
    await expect(inventory.state(scenarioId)).rejects.toMatchObject({ status: null });
    expect(cancelled).toBe(true);
  });

  it('treats a stream failure after receiving headers as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('Connection reset after external commit'));
            },
          }),
        ),
      ),
    );
    await expect(inventory.reserve(reserveBody)).rejects.toMatchObject({ status: null });
  });

  it('authenticates all adapter operations, encodes keys, bounds time, and disallows redirects', async () => {
    config.providerToken = 'test-only-provider-token';
    config.providerTimeoutMs = 500;
    const fetchMock = respond({
      outcome: 'cancelled',
      key: 'space / ?',
      scenarioId,
      reservation: null,
    });
    await inventory.cancel('space / ?', scenarioId, 'Abandon unresolved work');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${config.inventoryUrl}/reservations/space%20%2F%20%3F/cancel`,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: 'Bearer test-only-provider-token',
        },
        body: JSON.stringify({ scenarioId, reason: 'Abandon unresolved work' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('passes explicit provider rejection through and never retries network errors', async () => {
    respond({ error: 'Stock is stale' }, 409);
    await expect(inventory.reserve(reserveBody)).rejects.toMatchObject({
      status: 409,
      message: 'Stock is stale',
    });
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('http://127.0.0.1:1', '/health')).rejects.toMatchObject({ status: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
