import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';
import type { Principal } from './auth.js';

export const DEMO_WORKSPACE = '00000000-0000-4000-8000-000000000001';
export const demoPrincipal: Principal = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Demo operator',
  role: 'admin',
  workspaceId: DEMO_WORKSPACE,
};
const scope = new AsyncLocalStorage<Principal>();
export function asPrincipal<T>(principal: Principal, fn: () => T): T {
  return scope.run(principal, fn);
}
export function principal(): Principal {
  const current = scope.getStore();
  if (!current && config.mode === 'pilot')
    throw new Error('An authenticated workspace context is required.');
  return current ?? demoPrincipal;
}
export function workspaceId(): string {
  return principal().workspaceId;
}
