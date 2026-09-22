// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Plan } from '../shared/contracts';
import { App } from './App';
import type { Session } from './AuthBoundary';

const operator: Session = {
  mode: 'pilot',
  principal: { id: 'operator-1', name: 'Alex', role: 'operator', workspaceId: 'workshop' },
};
const allocation = {
  orderId: 'order-1',
  warehouse: 'Depot',
  part: 'Rotor',
  quantity: 2,
  laneId: 'lane-1',
  mode: 'van',
  hours: 2,
  cost: 80,
  stockVersion: 1,
};
const snapshot = {
  observedAt: '2026-09-22T10:00:00Z',
  stock: [{ warehouse: 'Depot', part: 'Rotor', available: 5, version: 1 }],
};
function state(status: Plan['status'] = 'approved'): AppState {
  return {
    scenario: {
      id: 'scenario-1',
      name: 'Repair workshop',
      description: 'A delayed parts delivery.',
      orders: [
        {
          id: 'order-1',
          factory: 'Workshop',
          part: 'Rotor',
          quantity: 2,
          deadlineHours: 5,
          priority: 1,
        },
      ],
      lanes: [
        {
          id: 'lane-1',
          warehouse: 'Depot',
          factory: 'Workshop',
          mode: 'van',
          hours: 2,
          unitCost: 40,
          capacity: 5,
        },
      ],
    },
    snapshot,
    plans: [
      {
        id: 'plan-1',
        scenarioId: 'scenario-1',
        strategy: 'optimized',
        snapshot,
        solution: {
          allocations: [allocation],
          unfilled: [],
          totalCost: 80,
          fulfilledPriority: 1,
          solverStatus: 'OPTIMAL',
          solveMs: 1,
          explanation: 'A feasible transfer.',
        },
        hash: 'approved-fingerprint',
        status,
        reason: null,
        createdAt: '2026-09-22T10:00:01Z',
        approvedAt: status === 'proposed' ? null : '2026-09-22T10:00:02Z',
        actions:
          status === 'proposed'
            ? []
            : [
                {
                  id: 'action-1',
                  planId: 'plan-1',
                  allocation,
                  stage: 'pending',
                  reservation: null,
                  shipment: null,
                  error: null,
                },
              ],
      },
    ],
    events: [],
    world: null,
    serviceWarning: null,
    runtime: { mode: 'pilot', demoControls: false, workspaceId: 'workshop' },
  };
}
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<App />));
}
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function fill(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('private pilot workbench', () => {
  it('checks session before fetching workspace data and clears the operator key before awaiting login', async () => {
    const session = deferred<Response>();
    const login = deferred<Response>();
    let loggedIn = false;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/session') return loggedIn ? reply(operator) : session.promise;
      if (url === '/api/auth/login') return login.promise;
      if (url === '/api/state') return reply(state());
      throw new Error(`Unexpected request ${url}`);
    });
    await mount();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/session']);
    expect(container.textContent).toContain('Checking your session');
    await act(async () => {
      session.resolve(reply({ mode: 'pilot', principal: null }));
    });
    expect(container.querySelector('#operator-key')).not.toBeNull();
    expect(fetchMock.mock.calls).toHaveLength(1);
    await fill('#operator-key', 'test-only-provisioned-operator-key');
    await submit(container.querySelector('form')!);
    const input = container.querySelector<HTMLInputElement>('#operator-key')!;
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    expect(input.disabled).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(fetchMock.mock.calls[1]).toMatchObject([
      '/api/auth/login',
      { body: JSON.stringify({ key: 'test-only-provisioned-operator-key' }) },
    ]);
    loggedIn = true;
    await act(async () => {
      login.resolve(reply(operator));
    });
    expect(container.textContent).toContain('Alex');
    expect(container.textContent).toContain('Known inventory');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/session',
      '/api/auth/login',
      '/api/session',
      '/api/state',
    ]);
  });

  it('hides every simulator control and blocks viewer mutations while preserving evidence access', async () => {
    const viewer: Session = { ...operator, principal: { ...operator.principal!, role: 'viewer' } };
    fetchMock.mockImplementation(async (url) =>
      reply(url === '/api/session' ? viewer : state('proposed')),
    );
    await mount();
    expect(container.textContent).toContain('Read-only access');
    expect(container.textContent).not.toContain('Reset demo');
    expect(container.textContent).not.toContain('Consume stock');
    expect(container.textContent).not.toContain('What actually happened');
    expect(container.textContent).not.toContain('Restore normal service');
    for (const label of ['Optimize a plan', 'Compare greedy', 'Approve $80', 'Refresh']) {
      expect(button(label).disabled).toBe(true);
      await act(async () => {
        button(label).click();
      });
    }
    expect(button('Export evidence').disabled).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/session', '/api/state']);
  });

  it('removes workspace data on an action 401 and retains uncertainty through signing back in', async () => {
    let expired = false;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/session') return reply(operator);
      if (url === '/api/auth/login') {
        expired = false;
        return reply(operator);
      }
      if (url === '/api/plans/plan-1/step') {
        expired = true;
        return reply({ error: 'Expired' }, 401);
      }
      return expired ? reply({ error: 'Expired' }, 401) : reply(state());
    });
    await mount();
    await act(async () => {
      button('Dispatch one').click();
    });
    expect(container.textContent).not.toContain('Known inventory');
    expect(container.querySelector('#operator-key')).not.toBeNull();
    expect(container.textContent).toContain('A dispatch may already have happened');
    await fill('#operator-key', 'replacement-test-key');
    await submit(container.querySelector('form')!);
    expect(container.textContent).toContain('Known inventory');
    expect(container.textContent).toContain('A dispatch may already have happened');
  });

  it('retains a lost-response warning when the next state refresh discovers session expiry', async () => {
    let expired = false;
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/session') return reply(operator);
      if (url === '/api/plans/plan-1/step') {
        expired = true;
        throw new TypeError('Network connection lost');
      }
      return expired ? reply({ error: 'Expired' }, 401) : reply(state());
    });
    await mount();
    await act(async () => {
      button('Dispatch one').click();
    });
    expect(container.querySelector('#operator-key')).not.toBeNull();
    expect(container.textContent).toContain('A dispatch may already have happened');
  });

  it.each(['approved', 'uncertain'] as const)(
    'prevents a viewer executing or cancelling a %s plan',
    async (status) => {
      const viewer: Session = {
        ...operator,
        principal: { ...operator.principal!, role: 'viewer' },
      };
      fetchMock.mockImplementation(async (url) =>
        reply(url === '/api/session' ? viewer : state(status)),
      );
      await mount();
      expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
      expect(button('Cancel remaining transfers').disabled).toBe(true);
      const commands =
        status === 'approved' ? ['Dispatch one', 'Dispatch remaining'] : ['Check & recover'];
      for (const command of commands) {
        expect(button(command).disabled).toBe(true);
        await act(async () => {
          button(command).click();
        });
      }
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/session', '/api/state']);
    },
  );

  it('does not echo a failed sign-in response or keep the rejected key', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === '/api/session'
        ? reply({ mode: 'pilot', principal: null })
        : reply({ error: 'Rejected secret-only-test-key' }, 401),
    );
    await mount();
    await fill('#operator-key', 'secret-only-test-key');
    await submit(container.querySelector('form')!);
    expect(container.textContent).toContain('The operator key was not accepted');
    expect(container.textContent).not.toContain('secret-only-test-key');
    expect(container.querySelector<HTMLInputElement>('#operator-key')!.value).toBe('');
  });

  it('keeps the read view when the server denies an operator command', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/session') return reply(operator);
      if (url === '/api/plans/plan-1/step')
        return reply({ error: 'Your current role cannot execute transfers.' }, 403);
      return reply(state());
    });
    await mount();
    await act(async () => {
      button('Dispatch one').click();
    });
    expect(container.textContent).toContain('Your current role cannot execute transfers.');
    expect(container.textContent).toContain('Known inventory');
    expect(container.querySelector('#operator-key')).toBeNull();
  });

  it('requires a substantive cancellation reason, blocks duplicate submission and displays the returned hold', async () => {
    const cancellation = deferred<Response>();
    let current = state();
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/session') return reply(operator);
      if (url === '/api/plans/plan-1/cancel') return cancellation.promise;
      return reply(current);
    });
    await mount();
    const reason = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(reason.minLength).toBe(10);
    expect(reason.maxLength).toBe(1000);
    await fill('textarea', '         x');
    expect(button('Cancel remaining transfers').disabled).toBe(true);
    await submit(container.querySelector('form')!);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
    await fill('textarea', '  Repair is no longer required.  ');
    await submit(container.querySelector('form')!);
    expect(button('Cancel remaining transfers').disabled).toBe(true);
    expect(button('Dispatch one').disabled).toBe(true);
    await submit(container.querySelector('form')!);
    const cancellations = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0][1]?.body).toBe(
      JSON.stringify({ reason: 'Repair is no longer required.' }),
    );
    current = state('uncertain');
    current.plans[0].reason = 'Carrier cancellation is not confirmed. Stock remains held.';
    await act(async () => {
      cancellation.resolve(reply(current));
    });
    expect(container.textContent).toContain('Stock remains held.');
    expect(container.textContent).toContain('Confirmed shipments remain committed.');
    expect(button('Check & recover').disabled).toBe(false);
  });

  it('signs out through the server and removes the previous workspace', async () => {
    fetchMock.mockImplementation(async (url) => reply(url === '/api/session' ? operator : state()));
    await mount();
    await act(async () => {
      button('Sign out').click();
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, options]) => url === '/api/auth/logout' && options?.method === 'POST',
      ),
    ).toBe(true);
    expect(container.textContent).not.toContain('Known inventory');
    expect(container.querySelector('#operator-key')).not.toBeNull();
  });

  it('shows an empty pilot workspace without offering a destructive demo reset', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === '/api/session'
        ? reply(operator)
        : reply({ error: 'Workspace has no scenario.' }, 409),
    );
    await mount();
    expect(container.textContent).toContain('Workspace has no scenario.');
    expect(container.textContent).toContain('an administrator must import its scenario');
    expect(container.textContent).not.toContain('Start demo');
    expect(container.textContent).not.toContain('Reset demo');
  });

  it('preserves public demo controls when the server explicitly enables demo mode', async () => {
    const demo = state();
    demo.runtime = { mode: 'demo', demoControls: true, workspaceId: 'demo' };
    fetchMock.mockImplementation(async (url) =>
      reply(url === '/api/session' ? { mode: 'demo', principal: null } : demo),
    );
    await mount();
    expect(container.textContent).toContain('PUBLIC DEMO');
    expect(button('Reset demo').disabled).toBe(false);
    expect(container.textContent).toContain('What actually happened');
    expect(container.textContent).toContain('Consume stock');
    expect(container.textContent).not.toContain('Sign out');
    expect(container.querySelector('#operator-key')).toBeNull();
  });
});
