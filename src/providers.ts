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
export async function request<T>(base: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.providerTimeoutMs),
    });
  } catch {
    throw new ProviderError('Provider response unavailable; outcome must be reconciled.', null);
  }
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new ProviderError(data.error ?? `Provider returned ${response.status}`, response.status);
  return data;
}
export async function lookup<T>(base: string, path: string): Promise<T | null> {
  try {
    return await request<T>(base, path);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return null;
    throw error;
  }
}
export const inventory = {
  state: (scenarioId: string) =>
    request<{ stock: Stock[]; reservations: Reservation[] }>(
      config.inventoryUrl,
      `/scenarios/${scenarioId}`,
    ),
  find: (key: string) =>
    lookup<Reservation>(config.inventoryUrl, `/reservations/${encodeURIComponent(key)}`),
  reserve: (body: {
    key: string;
    scenarioId: string;
    warehouse: string;
    part: string;
    quantity: number;
    expectedVersion: number;
  }) => request<Reservation>(config.inventoryUrl, '/reservations', body),
  consume: (key: string) =>
    request<Reservation>(
      config.inventoryUrl,
      `/reservations/${encodeURIComponent(key)}/consume`,
      {},
    ),
  release: (key: string) =>
    request<Reservation>(
      config.inventoryUrl,
      `/reservations/${encodeURIComponent(key)}/release`,
      {},
    ),
};
export const carrier = {
  state: (scenarioId: string) =>
    request<{ shipments: Shipment[]; lookupAvailable: boolean }>(
      config.carrierUrl,
      `/scenarios/${scenarioId}`,
    ),
  find: (key: string, scenarioId: string) =>
    lookup<Shipment>(
      config.carrierUrl,
      `/shipments/${encodeURIComponent(key)}?scenarioId=${scenarioId}`,
    ),
  dispatch: (body: Omit<Shipment, 'createdAt' | 'status'>) =>
    request<Shipment>(config.carrierUrl, '/shipments', body),
};
