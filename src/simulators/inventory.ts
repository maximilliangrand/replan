import { z } from 'zod';
import type { Reservation, Stock } from '../../shared/contracts.js';
import {
  identifier,
  quantity,
  scenarioId,
  service,
  ServiceError,
  samePayload,
  version,
} from './common.js';

const stockSchema = z.strictObject({
  warehouse: identifier,
  part: identifier,
  available: z.number().int().min(0).max(1_000_000),
  version,
});
const initializeSchema = z
  .strictObject({ scenarioId, stock: z.array(stockSchema).max(500) })
  .refine(
    ({ stock }) =>
      new Set(stock.map((item) => JSON.stringify([item.warehouse, item.part]))).size ===
      stock.length,
    { message: 'Stock entries must have unique warehouse and part pairs' },
  );
const reservationSchema = z.strictObject({
  key: identifier,
  scenarioId,
  warehouse: identifier,
  part: identifier,
  quantity,
  expectedVersion: version,
});
const externalConsumeSchema = z.strictObject({ warehouse: identifier, part: identifier, quantity });
const emptySchema = z.strictObject({});

interface StockRow {
  warehouse: string;
  part: string;
  available: number;
  version: number;
}
interface ReservationRow {
  key: string;
  scenario_id: string;
  warehouse: string;
  part: string;
  quantity: number;
  version: number;
  status: 'held' | 'consumed' | 'released';
  payload: unknown;
}
function reservation(row: ReservationRow): Reservation {
  return {
    key: row.key,
    scenarioId: row.scenario_id,
    warehouse: row.warehouse,
    part: row.part,
    quantity: row.quantity,
    version: row.version,
    status: row.status,
  };
}

export async function createInventory(databaseURL: string) {
  const { app, pool } = service(databaseURL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory_scenarios (
      id uuid PRIMARY KEY, initial_stock jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_stock (
      scenario_id uuid NOT NULL REFERENCES inventory_scenarios(id),
      warehouse text NOT NULL, part text NOT NULL,
      available integer NOT NULL CHECK (available >= 0),
      version integer NOT NULL CHECK (version >= 0),
      PRIMARY KEY (scenario_id, warehouse, part)
    );
    CREATE TABLE IF NOT EXISTS inventory_reservations (
      key text PRIMARY KEY, scenario_id uuid NOT NULL REFERENCES inventory_scenarios(id),
      warehouse text NOT NULL, part text NOT NULL,
      quantity integer NOT NULL CHECK (quantity > 0), version integer NOT NULL,
      status text NOT NULL CHECK (status IN ('held', 'consumed', 'released')), payload jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inventory_reservations_scenario ON inventory_reservations(scenario_id);
  `);

  app.post('/scenarios', async (request, reply) => {
    const input = initializeSchema.parse(request.body);
    const stock = [...input.stock].sort(
      (a, b) => a.warehouse.localeCompare(b.warehouse) || a.part.localeCompare(b.part),
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `scenario:${input.scenarioId}`,
      ]);
      const existing = await client.query<{ initial_stock: Stock[] }>(
        'SELECT initial_stock FROM inventory_scenarios WHERE id=$1',
        [input.scenarioId],
      );
      if (existing.rowCount) {
        if (!samePayload(existing.rows[0]!.initial_stock, stock))
          throw new ServiceError(409, 'Scenario already exists with different initial stock');
        await client.query('COMMIT');
        return { scenarioId: input.scenarioId };
      }
      await client.query('INSERT INTO inventory_scenarios(id, initial_stock) VALUES($1,$2)', [
        input.scenarioId,
        JSON.stringify(stock),
      ]);
      for (const item of stock) {
        await client.query(
          'INSERT INTO inventory_stock(scenario_id,warehouse,part,available,version) VALUES($1,$2,$3,$4,$5)',
          [input.scenarioId, item.warehouse, item.part, item.available, item.version],
        );
      }
      await client.query('COMMIT');
      return reply.code(201).send({ scenarioId: input.scenarioId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/scenarios/:id', async (request) => {
    const { id } = z.strictObject({ id: scenarioId }).parse(request.params);
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (!(await client.query('SELECT id FROM inventory_scenarios WHERE id=$1', [id])).rowCount)
        throw new ServiceError(404, 'Scenario not found');
      const stock = await client.query<StockRow>(
        'SELECT warehouse,part,available,version FROM inventory_stock WHERE scenario_id=$1 ORDER BY warehouse,part',
        [id],
      );
      const reservations = await client.query<ReservationRow>(
        'SELECT * FROM inventory_reservations WHERE scenario_id=$1 ORDER BY key',
        [id],
      );
      await client.query('COMMIT');
      return { stock: stock.rows, reservations: reservations.rows.map(reservation) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/reservations', async (request, reply) => {
    const input = reservationSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the key before checking it. A lost-response retry cannot subtract stock twice.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `reservation:${input.key}`,
      ]);
      const existing = await client.query<ReservationRow>(
        'SELECT * FROM inventory_reservations WHERE key=$1',
        [input.key],
      );
      if (existing.rowCount) {
        if (!samePayload(existing.rows[0]!.payload, input))
          throw new ServiceError(409, 'Idempotency key already used with a different reservation');
        await client.query('COMMIT');
        return reservation(existing.rows[0]!);
      }
      const updated = await client.query<{ version: number }>(
        `
        UPDATE inventory_stock SET available=available-$4,version=version+1
        WHERE scenario_id=$1 AND warehouse=$2 AND part=$3 AND version=$5 AND available >= $4
        RETURNING version`,
        [input.scenarioId, input.warehouse, input.part, input.quantity, input.expectedVersion],
      );
      if (!updated.rowCount)
        throw new ServiceError(409, 'Stock is missing, stale, or insufficient; refresh and replan');
      const created = await client.query<ReservationRow>(
        `
        INSERT INTO inventory_reservations(key,scenario_id,warehouse,part,quantity,version,status,payload)
        VALUES($1,$2,$3,$4,$5,$6,'held',$7) RETURNING *`,
        [
          input.key,
          input.scenarioId,
          input.warehouse,
          input.part,
          input.quantity,
          updated.rows[0]!.version,
          JSON.stringify(input),
        ],
      );
      await client.query('COMMIT');
      return reply.code(201).send(reservation(created.rows[0]!));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/reservations/:key', async (request) => {
    const { key } = z.strictObject({ key: identifier }).parse(request.params);
    const result = await pool.query<ReservationRow>(
      'SELECT * FROM inventory_reservations WHERE key=$1',
      [key],
    );
    if (!result.rowCount) throw new ServiceError(404, 'Reservation not found');
    return reservation(result.rows[0]!);
  });

  app.post('/reservations/:key/consume', async (request) => {
    const { key } = z.strictObject({ key: identifier }).parse(request.params);
    emptySchema.parse(request.body);
    const result = await pool.query<ReservationRow>(
      "UPDATE inventory_reservations SET status='consumed' WHERE key=$1 AND status IN ('held','consumed') RETURNING *",
      [key],
    );
    if (!result.rowCount) {
      if ((await pool.query('SELECT key FROM inventory_reservations WHERE key=$1', [key])).rowCount)
        throw new ServiceError(409, 'Released inventory cannot be consumed');
      throw new ServiceError(404, 'Reservation not found');
    }
    return reservation(result.rows[0]!);
  });

  app.post('/reservations/:key/release', async (request) => {
    const { key } = z.strictObject({ key: identifier }).parse(request.params);
    emptySchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<ReservationRow>(
        'SELECT * FROM inventory_reservations WHERE key=$1 FOR UPDATE',
        [key],
      );
      if (!existing.rowCount) throw new ServiceError(404, 'Reservation not found');
      const current = existing.rows[0]!;
      if (current.status === 'consumed')
        throw new ServiceError(409, 'Dispatched inventory cannot be released');
      if (current.status === 'released') {
        await client.query('COMMIT');
        return reservation(current);
      }
      const stock = await client.query<{ version: number }>(
        `
        UPDATE inventory_stock SET available=available+$4,version=version+1
        WHERE scenario_id=$1 AND warehouse=$2 AND part=$3 RETURNING version`,
        [current.scenario_id, current.warehouse, current.part, current.quantity],
      );
      const result = await client.query<ReservationRow>(
        "UPDATE inventory_reservations SET status='released',version=$2 WHERE key=$1 RETURNING *",
        [key, stock.rows[0]!.version],
      );
      await client.query('COMMIT');
      return reservation(result.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/scenarios/:id/consume', async (request) => {
    const { id } = z.strictObject({ id: scenarioId }).parse(request.params);
    const input = externalConsumeSchema.parse(request.body);
    const result = await pool.query<StockRow>(
      `
      UPDATE inventory_stock SET available=available-$4,version=version+1
      WHERE scenario_id=$1 AND warehouse=$2 AND part=$3 AND available >= $4
      RETURNING warehouse,part,available,version`,
      [id, input.warehouse, input.part, input.quantity],
    );
    if (!result.rowCount) throw new ServiceError(409, 'Stock is missing or insufficient');
    return result.rows[0]!;
  });
  return app;
}
