import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCarrier } from '../src/simulators/carrier.js';
import { createInventory } from '../src/simulators/inventory.js';
import type { Reservation, Shipment } from '../shared/contracts.js';

const inventoryURL =
  process.env.TEST_INVENTORY_DATABASE_URL ??
  'postgresql://replan@127.0.0.1:55432/replan_inventory_test';
const carrierURL =
  process.env.TEST_CARRIER_DATABASE_URL ??
  'postgresql://replan@127.0.0.1:55432/replan_carrier_test';
let inventory: Awaited<ReturnType<typeof createInventory>>;
let carrier: Awaited<ReturnType<typeof createCarrier>>;
let carrierAddress: string;
const scenarios: string[] = [];

beforeAll(async () => {
  inventory = await createInventory(inventoryURL);
  carrier = await createCarrier(carrierURL);
  carrierAddress = await carrier.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await inventory?.close();
  await carrier?.close();
  // Delete only this run's random scenario IDs; leave other processes' fixtures alone.
  const inventoryPool = new Pool({ connectionString: inventoryURL });
  const carrierPool = new Pool({ connectionString: carrierURL });
  try {
    await inventoryPool.query(
      'DELETE FROM inventory_reservations WHERE scenario_id=ANY($1::uuid[])',
      [scenarios],
    );
    await inventoryPool.query('DELETE FROM inventory_stock WHERE scenario_id=ANY($1::uuid[])', [
      scenarios,
    ]);
    await inventoryPool.query('DELETE FROM inventory_scenarios WHERE id=ANY($1::uuid[])', [
      scenarios,
    ]);
    await carrierPool.query('DELETE FROM carrier_shipments WHERE scenario_id=ANY($1::uuid[])', [
      scenarios,
    ]);
    await carrierPool.query('DELETE FROM carrier_scenarios WHERE id=ANY($1::uuid[])', [scenarios]);
  } finally {
    await inventoryPool.end();
    await carrierPool.end();
  }
});

async function scenario(available = 6) {
  const scenarioId = randomUUID();
  scenarios.push(scenarioId);
  const stock = [{ warehouse: 'Vienna', part: 'BRG-42', available, version: 1 }];
  expect(
    (await inventory.inject({ method: 'POST', url: '/scenarios', payload: { scenarioId, stock } }))
      .statusCode,
  ).toBe(201);
  expect(
    (await carrier.inject({ method: 'POST', url: '/scenarios', payload: { scenarioId } }))
      .statusCode,
  ).toBe(201);
  return { scenarioId, stock };
}

function reservationRequest(scenarioId: string) {
  return {
    key: randomUUID(),
    scenarioId,
    warehouse: 'Vienna',
    part: 'BRG-42',
    quantity: 4,
    expectedVersion: 1,
  };
}
function shipmentRequest(scenarioId: string) {
  return {
    key: randomUUID(),
    scenarioId,
    orderId: 'repair-001',
    warehouse: 'Vienna',
    quantity: 4,
    laneId: 'truck-vienna',
    cost: 320,
  };
}

describe('authoritative inventory', () => {
  it('serializes duplicate reservations and replays the original result after stock changes', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        inventory.inject({ method: 'POST', url: '/reservations', payload }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.every((response) => [200, 201].includes(response.statusCode))).toBe(true);
    expect(responses.map((response) => response.json<Reservation>())).toEqual(
      Array.from({ length: 12 }, () => ({
        key: payload.key,
        scenarioId,
        warehouse: 'Vienna',
        part: 'BRG-42',
        quantity: 4,
        version: 2,
        status: 'held',
      })),
    );
    const world = (await inventory.inject(`/scenarios/${scenarioId}`)).json();
    expect(world.stock[0]).toMatchObject({ available: 2, version: 2 });
    expect(world.reservations).toHaveLength(1);
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: '/reservations',
          payload: { ...payload, quantity: 1 },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('rejects a stale concurrent reservation and prevents overselling after a refresh', async () => {
    const { scenarioId } = await scenario();
    const payloads = [reservationRequest(scenarioId), reservationRequest(scenarioId)];
    const responses = await Promise.all(
      payloads.map((payload) =>
        inventory.inject({ method: 'POST', url: '/reservations', payload }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const rejected = payloads[responses.findIndex((response) => response.statusCode === 409)]!;
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: '/reservations',
          payload: { ...rejected, expectedVersion: 2 },
        })
      ).statusCode,
    ).toBe(409);
    const world = (await inventory.inject(`/scenarios/${scenarioId}`)).json();
    expect(world.stock[0].available).toBe(2);
    expect(world.reservations).toHaveLength(1);
  });

  it('arbitrates an external stock consumer against a reservation without overselling', async () => {
    const { scenarioId } = await scenario();
    const reservation = inventory.inject({
      method: 'POST',
      url: '/reservations',
      payload: reservationRequest(scenarioId),
    });
    const external = inventory.inject({
      method: 'POST',
      url: `/scenarios/${scenarioId}/consume`,
      payload: { warehouse: 'Vienna', part: 'BRG-42', quantity: 4 },
    });
    const responses = await Promise.all([reservation, external]);
    expect(responses.filter((response) => [200, 201].includes(response.statusCode))).toHaveLength(
      1,
    );
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1);
    expect((await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0]).toMatchObject({
      available: 2,
      version: 2,
    });
  });

  it('preserves mutable stock when scenario initialization is replayed', async () => {
    const initial = await scenario();
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: `/scenarios/${initial.scenarioId}/consume`,
          payload: { warehouse: 'Vienna', part: 'BRG-42', quantity: 1 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await inventory.inject({ method: 'POST', url: '/scenarios', payload: initial })).statusCode,
    ).toBe(200);
    expect(
      (await inventory.inject(`/scenarios/${initial.scenarioId}`)).json().stock[0],
    ).toMatchObject({ available: 5, version: 2 });
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: '/scenarios',
          payload: { ...initial, stock: [{ ...initial.stock[0], available: 100 }] },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: '/reservations',
          payload: reservationRequest(initial.scenarioId),
        })
      ).statusCode,
    ).toBe(409);
  });

  it('releases a held reservation once and never releases already consumed inventory', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    await inventory.inject({ method: 'POST', url: '/reservations', payload });
    const releases = await Promise.all(
      Array.from({ length: 8 }, () =>
        inventory.inject({
          method: 'POST',
          url: `/reservations/${payload.key}/release`,
          payload: {},
        }),
      ),
    );
    expect(
      releases.every(
        (response) => response.statusCode === 200 && response.json().status === 'released',
      ),
    ).toBe(true);
    expect((await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0]).toMatchObject({
      available: 6,
      version: 3,
    });
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: `/reservations/${payload.key}/consume`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const replay = await inventory.inject({ method: 'POST', url: '/reservations', payload });
    expect(replay.json().status).toBe('released');
    const next = { ...payload, key: randomUUID(), expectedVersion: 3 };
    expect(
      (await inventory.inject({ method: 'POST', url: '/reservations', payload: next })).statusCode,
    ).toBe(201);
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: `/reservations/${next.key}/consume`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: `/reservations/${next.key}/consume`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: `/reservations/${next.key}/release`,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    expect((await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0]).toMatchObject({
      available: 2,
      version: 4,
    });
  });

  it('rejects malformed or unknown-field requests without changing world state', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    for (const invalid of [
      { ...payload, quantity: -1 },
      { ...payload, quantity: '4' },
      { ...payload, override: true },
    ]) {
      expect(
        (await inventory.inject({ method: 'POST', url: '/reservations', payload: invalid }))
          .statusCode,
      ).toBe(400);
    }
    expect((await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0].available).toBe(6);
    expect((await inventory.inject(`/reservations/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('allows either release or consumption to win a race, never both', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    await inventory.inject({ method: 'POST', url: '/reservations', payload });
    const responses = await Promise.all(
      ['release', 'consume'].map((operation) =>
        inventory.inject({
          method: 'POST',
          url: `/reservations/${payload.key}/${operation}`,
          payload: {},
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const reservation = (
      await inventory.inject(`/reservations/${payload.key}`)
    ).json<Reservation>();
    const available = (await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0]
      .available;
    expect(available).toBe(reservation.status === 'released' ? 6 : 2);
  });

  it('keeps a reservation and its exact idempotency contract across a service restart', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    const original = (
      await inventory.inject({ method: 'POST', url: '/reservations', payload })
    ).json<Reservation>();
    await inventory.close();
    inventory = await createInventory(inventoryURL);
    expect((await inventory.inject(`/reservations/${payload.key}`)).json()).toEqual(original);
    expect(
      (await inventory.inject({ method: 'POST', url: '/reservations', payload })).json(),
    ).toEqual(original);
    const world = (await inventory.inject(`/scenarios/${scenarioId}`)).json();
    expect(world.stock[0]).toMatchObject({ available: 2, version: 2 });
    expect(world.reservations).toHaveLength(1);
  });
});

describe('irreversible carrier simulator', () => {
  it('deduplicates keys and rejects different payloads or second commitments for the same order', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        carrier.inject({ method: 'POST', url: '/shipments', payload }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.every((response) => [200, 201].includes(response.statusCode))).toBe(true);
    expect(new Set(responses.map((response) => response.json<Shipment>().createdAt)).size).toBe(1);
    expect(
      (
        await carrier.inject({
          method: 'POST',
          url: '/shipments',
          payload: { ...payload, quantity: 3 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await carrier.inject({
          method: 'POST',
          url: '/shipments',
          payload: { ...payload, key: randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    expect((await carrier.inject(`/scenarios/${scenarioId}`)).json().shipments).toHaveLength(1);
  });

  it('arbitrates concurrent distinct keys for a single order', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    const responses = await Promise.all(
      [payload, { ...payload, key: randomUUID() }].map((input) =>
        carrier.inject({ method: 'POST', url: '/shipments', payload: input }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((await carrier.inject(`/scenarios/${scenarioId}`)).json().shipments).toHaveLength(1);
  });

  it('commits before losing the HTTP response and reconciles from durable state after a restart', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    await carrier.inject({
      method: 'POST',
      url: `/scenarios/${scenarioId}/fault`,
      payload: { fault: 'lost_response' },
    });
    await expect(
      fetch(`${carrierAddress}/shipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow();
    await carrier.close();
    carrier = await createCarrier(carrierURL);
    carrierAddress = await carrier.listen({ host: '127.0.0.1', port: 0 });
    const lookup = await carrier.inject(`/shipments/${payload.key}?scenarioId=${scenarioId}`);
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ ...payload, status: 'dispatched' });
    expect((await carrier.inject({ method: 'POST', url: '/shipments', payload })).statusCode).toBe(
      200,
    );
    const next = await carrier.inject({
      method: 'POST',
      url: '/shipments',
      payload: { ...payload, key: randomUUID(), orderId: 'repair-002' },
    });
    expect(next.statusCode).toBe(201); // The response fault was persisted as consumed.
    expect((await carrier.inject(`/scenarios/${scenarioId}`)).json().shipments).toHaveLength(2);
  });

  it('makes lookup failure distinguishable from authoritative absence while preserving evaluator truth', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    await carrier.inject({ method: 'POST', url: '/shipments', payload });
    await carrier.inject({
      method: 'POST',
      url: `/scenarios/${scenarioId}/fault`,
      payload: { fault: 'lookup_unavailable' },
    });
    expect(
      (await carrier.inject(`/shipments/${payload.key}?scenarioId=${scenarioId}`)).statusCode,
    ).toBe(503);
    const absentKey = randomUUID();
    expect(
      (await carrier.inject(`/shipments/${absentKey}?scenarioId=${scenarioId}`)).statusCode,
    ).toBe(503);
    const truth = (await carrier.inject(`/scenarios/${scenarioId}`)).json();
    expect(truth.lookupAvailable).toBe(false);
    expect(truth.shipments).toHaveLength(1);
    await carrier.inject({
      method: 'POST',
      url: `/scenarios/${scenarioId}/fault`,
      payload: { fault: 'clear' },
    });
    expect(
      (await carrier.inject(`/shipments/${payload.key}?scenarioId=${scenarioId}`)).statusCode,
    ).toBe(200);
    expect(
      (await carrier.inject(`/shipments/${absentKey}?scenarioId=${scenarioId}`)).statusCode,
    ).toBe(404);
  });

  it('can commit an in-flight dispatch after client timeout and a negative point-in-time lookup', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    const blocker = new Pool({ connectionString: carrierURL });
    const connection = await blocker.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM carrier_scenarios WHERE id=$1 FOR UPDATE', [
        scenarioId,
      ]);
      // A slow carrier transaction remains live even if its client's request times out.
      const dispatch = fetch(`${carrierAddress}/shipments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300),
      });
      await expect(dispatch).rejects.toThrow();
      expect(
        (await carrier.inject(`/shipments/${payload.key}?scenarioId=${scenarioId}`)).statusCode,
      ).toBe(404);
      await connection.query('COMMIT');
      await expect
        .poll(
          async () =>
            (await carrier.inject(`/shipments/${payload.key}?scenarioId=${scenarioId}`)).statusCode,
        )
        .toBe(200);
      expect((await carrier.inject(`/scenarios/${scenarioId}`)).json().shipments).toHaveLength(1);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await blocker.end();
    }
  });
});
