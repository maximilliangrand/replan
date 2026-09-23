import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
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
let inventoryAddress: string;
const scenarios: string[] = [];

beforeAll(async () => {
  inventory = await createInventory(inventoryURL);
  carrier = await createCarrier(carrierURL);
  inventoryAddress = await inventory.listen({ host: '127.0.0.1', port: 0 });
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
      'DELETE FROM inventory_cancellations WHERE scenario_id=ANY($1::uuid[])',
      [scenarios],
    );
    await carrierPool.query('DELETE FROM carrier_cancellations WHERE scenario_id=ANY($1::uuid[])', [
      scenarios,
    ]);
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
    inventoryAddress = await inventory.listen({ host: '127.0.0.1', port: 0 });
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
    await expect(post(carrierAddress, '/shipments', payload, 2_000)).rejects.toThrow();
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
      const dispatch = post(carrierAddress, '/shipments', payload, 300);
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

// Observe the actual database lock wait before releasing it, rather than using
// a timer to guess which external request reached its transaction first.
async function waitForKeyWaiters(pool: Pool, lockKey: string, count: number) {
  await expect
    .poll(async () => {
      const result = await pool.query<{ count: string }>(
        `
      SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted
      AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid
      AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1`,
        [lockKey],
      );
      return Number(result.rows[0]!.count);
    })
    .toBe(count);
}

function post(address: string, path: string, payload: unknown, timeout = 5_000) {
  // Own each fault-injection socket. Node 22's global fetch pool can open an
  // unused replacement connection after an abort, delaying a later server.close.
  // A non-pooled HTTP request still aborts the real client connection while the
  // independent provider transaction remains live behind its database lock.
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      address + path,
      {
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeout),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: { 'content-type': 'application/json' },
            }),
          );
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });
}

describe('terminal cancellation', () => {
  it('returns a committed shipment instead of claiming cancellation, including after restart', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    const shipment = (await carrier.inject({ method: 'POST', url: '/shipments', payload })).json();
    const cancellation = { scenarioId, reason: 'Operator requests cancellation' };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (
          await carrier.inject({
            method: 'POST',
            url: `/shipments/${payload.key}/cancel`,
            payload: cancellation,
          })
        ).json(),
      ).toEqual({ outcome: 'dispatched', shipment });
      if (attempt === 0) {
        await carrier.close();
        carrier = await createCarrier(carrierURL);
        carrierAddress = await carrier.listen({ host: '127.0.0.1', port: 0 });
      }
    }
    const other = await scenario();
    expect(
      (
        await carrier.inject({
          method: 'POST',
          url: `/shipments/${payload.key}/cancel`,
          payload: { ...cancellation, scenarioId: other.scenarioId },
        })
      ).statusCode,
    ).toBe(409);
    expect((await carrier.inject(`/scenarios/${scenarioId}`)).json().shipments).toHaveLength(1);
  });

  it.each(['carrier', 'inventory'] as const)(
    '%s fences a timed-out request queued behind a winning cancellation',
    async (kind) => {
      const { scenarioId } = await scenario();
      const simulator = kind === 'carrier' ? carrier : inventory;
      const address = kind === 'carrier' ? carrierAddress : inventoryAddress;
      const payload =
        kind === 'carrier' ? shipmentRequest(scenarioId) : reservationRequest(scenarioId);
      const path = kind === 'carrier' ? '/shipments' : '/reservations';
      const lockKey = `${kind === 'carrier' ? 'shipment' : 'reservation'}:${payload.key}`;
      const pool = new Pool({ connectionString: kind === 'carrier' ? carrierURL : inventoryURL });
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
        const cancel = post(address, `${path}/${payload.key}/cancel`, {
          scenarioId,
          reason: 'Abandon unresolved action',
        });
        await waitForKeyWaiters(pool, lockKey, 1);
        const late = post(address, path, payload, 500);
        // Attach immediately so the expected timeout is never an unhandled rejection.
        const timeout = expect(late).rejects.toThrow();
        await waitForKeyWaiters(pool, lockKey, 2);
        await timeout;
        expect(
          (
            await simulator.inject(
              `${path}/${payload.key}${kind === 'carrier' ? `?scenarioId=${scenarioId}` : ''}`,
            )
          ).statusCode,
        ).toBe(404);
        await connection.query('COMMIT');
        const cancelled = await cancel;
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toMatchObject({
          outcome: 'cancelled',
          key: payload.key,
          scenarioId,
        });
        await waitForKeyWaiters(pool, lockKey, 0);
        // A retry using the original exact payload is permanently rejected too.
        expect((await simulator.inject({ method: 'POST', url: path, payload })).statusCode).toBe(
          409,
        );
        const world = (await simulator.inject(`/scenarios/${scenarioId}`)).json();
        if (kind === 'carrier') expect(world.shipments).toEqual([]);
        else {
          expect(world.reservations).toEqual([]);
          expect(world.stock[0]).toMatchObject({ available: 6, version: 1 });
        }
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        await pool.end();
      }
    },
  );

  it('returns the shipment when a timed-out dispatch wins the lock before cancellation', async () => {
    const { scenarioId } = await scenario();
    const payload = shipmentRequest(scenarioId);
    const lockKey = `shipment:${payload.key}`;
    const pool = new Pool({ connectionString: carrierURL });
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);
      const dispatch = post(carrierAddress, '/shipments', payload, 500);
      const timeout = expect(dispatch).rejects.toThrow();
      await waitForKeyWaiters(pool, lockKey, 1);
      await timeout;
      const cancel = post(carrierAddress, `/shipments/${payload.key}/cancel`, {
        scenarioId,
        reason: 'Operator cancels unknown outcome',
      });
      await waitForKeyWaiters(pool, lockKey, 2);
      await connection.query('COMMIT');
      const result = await cancel;
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        outcome: 'dispatched',
        shipment: { ...payload, status: 'dispatched' },
      });
      expect((await carrier.inject(`/scenarios/${scenarioId}`)).json().shipments).toHaveLength(1);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });

  it('releases held inventory once, closes its key, and refuses to release consumed stock', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    await inventory.inject({ method: 'POST', url: '/reservations', payload });
    const cancellations = await Promise.all(
      Array.from({ length: 8 }, () =>
        inventory.inject({
          method: 'POST',
          url: `/reservations/${payload.key}/cancel`,
          payload: { scenarioId, reason: 'Approved transfer withdrawn' },
        }),
      ),
    );
    expect(cancellations.every((response) => response.statusCode === 200)).toBe(true);
    expect(cancellations[0]!.json()).toMatchObject({
      outcome: 'cancelled',
      key: payload.key,
      scenarioId,
      reservation: {
        key: payload.key,
        scenarioId,
        warehouse: payload.warehouse,
        part: payload.part,
        quantity: payload.quantity,
        status: 'released',
        version: 3,
      },
    });
    expect((await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0]).toMatchObject({
      available: 6,
      version: 3,
    });
    expect(
      (await inventory.inject({ method: 'POST', url: '/reservations', payload })).statusCode,
    ).toBe(409);
    const consumed = { ...payload, key: randomUUID(), expectedVersion: 3 };
    await inventory.inject({ method: 'POST', url: '/reservations', payload: consumed });
    await inventory.inject({
      method: 'POST',
      url: `/reservations/${consumed.key}/consume`,
      payload: {},
    });
    expect(
      (
        await inventory.inject({
          method: 'POST',
          url: `/reservations/${consumed.key}/cancel`,
          payload: { scenarioId, reason: 'Cannot release dispatched goods' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0]).toMatchObject({
      available: 2,
      version: 4,
    });
  });

  it('serializes cancellation against consumption, preserving exactly one inventory outcome', async () => {
    const { scenarioId } = await scenario();
    const payload = reservationRequest(scenarioId);
    await inventory.inject({ method: 'POST', url: '/reservations', payload });
    const responses = await Promise.all([
      inventory.inject({
        method: 'POST',
        url: `/reservations/${payload.key}/cancel`,
        payload: { scenarioId, reason: 'Operator cancellation' },
      }),
      inventory.inject({
        method: 'POST',
        url: `/reservations/${payload.key}/consume`,
        payload: {},
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const result = (await inventory.inject(`/reservations/${payload.key}`)).json();
    const stock = (await inventory.inject(`/scenarios/${scenarioId}`)).json().stock[0];
    expect(stock.available).toBe(result.status === 'consumed' ? 2 : 6);
  });

  it.each(['carrier', 'inventory'] as const)(
    '%s preserves absent-key tombstones across restart and rejects another scenario',
    async (kind) => {
      const { scenarioId } = await scenario();
      const other = await scenario();
      const key = randomUUID();
      const path = kind === 'carrier' ? '/shipments' : '/reservations';
      let simulator = kind === 'carrier' ? carrier : inventory;
      expect(
        (
          await simulator.inject({
            method: 'POST',
            url: `${path}/${key}/cancel`,
            payload: { scenarioId, reason: 'Terminally stop future use' },
          })
        ).statusCode,
      ).toBe(200);
      await simulator.close();
      if (kind === 'carrier') {
        carrier = await createCarrier(carrierURL);
        carrierAddress = await carrier.listen({ host: '127.0.0.1', port: 0 });
        simulator = carrier;
      } else {
        inventory = await createInventory(inventoryURL);
        inventoryAddress = await inventory.listen({ host: '127.0.0.1', port: 0 });
        simulator = inventory;
      }
      const replay = await simulator.inject({
        method: 'POST',
        url: `${path}/${key}/cancel`,
        payload: { scenarioId, reason: 'Safe replay after restart' },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ outcome: 'cancelled', key, scenarioId });
      expect(
        (
          await simulator.inject({
            method: 'POST',
            url: `${path}/${key}/cancel`,
            payload: { scenarioId: other.scenarioId, reason: 'Wrong scenario' },
          })
        ).statusCode,
      ).toBe(409);
      const payload = {
        ...(kind === 'carrier' ? shipmentRequest(scenarioId) : reservationRequest(scenarioId)),
        key,
      };
      expect((await simulator.inject({ method: 'POST', url: path, payload })).statusCode).toBe(409);
    },
  );
});

describe('simulator service authentication', () => {
  it.each(['carrier', 'inventory'] as const)(
    '%s refuses pilot startup without a service token',
    (kind) => {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/simulators/server.ts', kind],
        {
          cwd: process.cwd(),
          env: { ...process.env, REPLAN_MODE: 'pilot', SIMULATOR_TOKEN: '' },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SIMULATOR_TOKEN is required in pilot mode');
    },
  );

  it.each(['carrier', 'inventory'] as const)(
    '%s authenticates data and health checks with the currently provisioned credential',
    async (kind) => {
      const token = 'test-only-service-token';
      const app =
        kind === 'carrier'
          ? await createCarrier(carrierURL, { token })
          : await createInventory(inventoryURL, { token });
      try {
        const id = randomUUID();
        scenarios.push(id);
        const payload = kind === 'carrier' ? { scenarioId: id } : { scenarioId: id, stock: [] };
        expect((await app.inject('/health')).statusCode).toBe(401);
        for (const authorization of [
          undefined,
          'Bearer wrong',
          'Basic test-only-service-token',
          'Bearer test-only-service-toke',
        ]) {
          const headers = authorization ? { authorization } : {};
          expect((await app.inject({ method: 'GET', url: '/health', headers })).statusCode).toBe(
            401,
          );
          expect(
            (await app.inject({ method: 'POST', url: '/scenarios', payload, headers })).statusCode,
          ).toBe(401);
          expect(
            (await app.inject({ method: 'GET', url: `/scenarios/${id}`, headers })).statusCode,
          ).toBe(401);
        }
        const headers = { authorization: `Bearer ${token}` };
        expect((await app.inject({ method: 'GET', url: '/health', headers })).json()).toEqual({
          ok: true,
        });
        expect(
          (await app.inject({ method: 'POST', url: '/scenarios', payload, headers })).statusCode,
        ).toBe(201);
        expect(
          (await app.inject({ method: 'GET', url: `/scenarios/${id}`, headers })).statusCode,
        ).toBe(200);
        const path = kind === 'carrier' ? '/shipments' : '/reservations';
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${path}/${randomUUID()}/cancel`,
              payload: { scenarioId: id, reason: 'Authorized cancellation' },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `${path}/${randomUUID()}/cancel`,
              payload: { scenarioId: id, reason: 'Authorized cancellation' },
              headers,
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await app.close();
      }
    },
  );
});
