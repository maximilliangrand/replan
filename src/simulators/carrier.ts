import { z } from 'zod';
import type { Shipment } from '../../shared/contracts.js';
import { identifier, quantity, scenarioId, service, ServiceError, samePayload } from './common.js';

const shipmentSchema = z.strictObject({
  key: identifier,
  scenarioId,
  orderId: identifier,
  warehouse: identifier,
  quantity,
  laneId: identifier,
  cost: z.number().nonnegative().max(1_000_000_000),
});
interface ShipmentRow {
  key: string;
  scenario_id: string;
  order_id: string;
  warehouse: string;
  quantity: number;
  lane_id: string;
  cost: number;
  created_at: Date;
  payload: unknown;
}
function shipment(row: ShipmentRow): Shipment {
  return {
    key: row.key,
    scenarioId: row.scenario_id,
    orderId: row.order_id,
    warehouse: row.warehouse,
    quantity: row.quantity,
    laneId: row.lane_id,
    cost: row.cost,
    status: 'dispatched',
    createdAt: row.created_at.toISOString(),
  };
}

export async function createCarrier(databaseURL: string) {
  const { app, pool } = service(databaseURL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carrier_scenarios (
      id uuid PRIMARY KEY, lose_next_response boolean NOT NULL DEFAULT false,
      lookup_available boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS carrier_shipments (
      key text PRIMARY KEY, scenario_id uuid NOT NULL REFERENCES carrier_scenarios(id),
      order_id text NOT NULL, warehouse text NOT NULL,
      quantity integer NOT NULL CHECK (quantity > 0), lane_id text NOT NULL,
      cost double precision NOT NULL CHECK (cost >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), payload jsonb NOT NULL,
      UNIQUE (scenario_id,order_id)
    );
  `);

  app.post('/scenarios', async (request, reply) => {
    const input = z.strictObject({ scenarioId }).parse(request.body);
    const result = await pool.query(
      'INSERT INTO carrier_scenarios(id) VALUES($1) ON CONFLICT DO NOTHING',
      [input.scenarioId],
    );
    return reply.code(result.rowCount ? 201 : 200).send(input);
  });

  app.get('/scenarios/:id', async (request) => {
    const { id } = z.strictObject({ id: scenarioId }).parse(request.params);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scenario = await client.query<{ lookup_available: boolean }>(
        'SELECT lookup_available FROM carrier_scenarios WHERE id=$1',
        [id],
      );
      if (!scenario.rowCount) throw new ServiceError(404, 'Scenario not found');
      const result = await client.query<ShipmentRow>(
        'SELECT * FROM carrier_shipments WHERE scenario_id=$1 ORDER BY created_at,key',
        [id],
      );
      await client.query('COMMIT');
      return {
        shipments: result.rows.map(shipment),
        lookupAvailable: scenario.rows[0]!.lookup_available,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/shipments', async (request, reply) => {
    const input = shipmentSchema.parse(request.body);
    const client = await pool.connect();
    let created: Shipment;
    let lostResponse = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `shipment:${input.key}`,
      ]);
      const existing = await client.query<ShipmentRow>(
        'SELECT * FROM carrier_shipments WHERE key=$1',
        [input.key],
      );
      if (existing.rowCount) {
        if (!samePayload(existing.rows[0]!.payload, input))
          throw new ServiceError(409, 'Idempotency key already used with a different shipment');
        await client.query('COMMIT');
        return shipment(existing.rows[0]!);
      }
      const scenario = await client.query<{ lose_next_response: boolean }>(
        'SELECT lose_next_response FROM carrier_scenarios WHERE id=$1 FOR UPDATE',
        [input.scenarioId],
      );
      if (!scenario.rowCount) throw new ServiceError(404, 'Scenario not found');
      if (
        (
          await client.query(
            'SELECT key FROM carrier_shipments WHERE scenario_id=$1 AND order_id=$2',
            [input.scenarioId, input.orderId],
          )
        ).rowCount
      ) {
        throw new ServiceError(409, 'This order already has a dispatched shipment');
      }
      const result = await client.query<ShipmentRow>(
        `
        INSERT INTO carrier_shipments(key,scenario_id,order_id,warehouse,quantity,lane_id,cost,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          input.key,
          input.scenarioId,
          input.orderId,
          input.warehouse,
          input.quantity,
          input.laneId,
          input.cost,
          JSON.stringify(input),
        ],
      );
      created = shipment(result.rows[0]!);
      lostResponse = scenario.rows[0]!.lose_next_response;
      if (lostResponse)
        await client.query('UPDATE carrier_scenarios SET lose_next_response=false WHERE id=$1', [
          input.scenarioId,
        ]);
      // The external effect is committed before the response can be lost.
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (lostResponse) {
      reply.hijack();
      reply.raw.destroy();
      return reply;
    }
    return reply.code(201).send(created);
  });

  app.get('/shipments/:key', async (request) => {
    const { key } = z.strictObject({ key: identifier }).parse(request.params);
    const query = z.strictObject({ scenarioId: scenarioId.optional() }).parse(request.query);
    const result = await pool.query<ShipmentRow>('SELECT * FROM carrier_shipments WHERE key=$1', [
      key,
    ]);
    const lookupScenarioId = query.scenarioId ?? result.rows[0]?.scenario_id;
    if (lookupScenarioId) {
      const scenario = await pool.query<{ lookup_available: boolean }>(
        'SELECT lookup_available FROM carrier_scenarios WHERE id=$1',
        [lookupScenarioId],
      );
      if (scenario.rowCount && !scenario.rows[0]!.lookup_available)
        throw new ServiceError(
          503,
          'Carrier lookup is temporarily unavailable; shipment status is unknown',
        );
    }
    if (!result.rowCount || (query.scenarioId && result.rows[0]!.scenario_id !== query.scenarioId))
      throw new ServiceError(404, 'Shipment not found');
    return shipment(result.rows[0]!);
  });

  app.post('/scenarios/:id/fault', async (request) => {
    const { id } = z.strictObject({ id: scenarioId }).parse(request.params);
    const { fault } = z
      .strictObject({ fault: z.enum(['lost_response', 'lookup_unavailable', 'clear']) })
      .parse(request.body);
    const statement =
      fault === 'lost_response'
        ? 'lose_next_response=true'
        : fault === 'lookup_unavailable'
          ? 'lookup_available=false'
          : 'lose_next_response=false,lookup_available=true';
    const result = await pool.query(
      `UPDATE carrier_scenarios SET ${statement} WHERE id=$1 RETURNING lookup_available`,
      [id],
    );
    if (!result.rowCount) throw new ServiceError(404, 'Scenario not found');
    return { fault, lookupAvailable: result.rows[0].lookup_available };
  });
  return app;
}
