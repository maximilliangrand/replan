import { expect, type Page } from '@playwright/test';
import type { AppState } from '../shared/contracts.js';
import { verifyEvidence } from '../src/replay.js';
import { test, type Pilot } from './pilot-fixture.js';

async function login(page: Page, pilot: Pilot, key = pilot.operator.key) {
  await page.goto(pilot.origin);
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace.' })).toBeVisible();
  // Do not let a failed interaction print an ephemeral credential in CI output.
  try {
    await page.getByLabel('Operator key').fill(key);
  } catch {
    throw new Error('The sign-in field was unavailable.');
  }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
}
async function approve(page: Page) {
  await page.getByRole('button', { name: 'Optimize a plan', exact: true }).click();
  await page.getByRole('button', { name: 'Approve $440', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dispatch remaining', exact: true })).toBeEnabled();
}
async function state(page: Page): Promise<AppState> {
  return page.evaluate(async () => {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Workspace state unavailable');
    return response.json();
  });
}

test('HTTPS browser approves, reconciles a lost response, and exports three unique commitments', async ({
  page,
  pilot,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, pilot);
  expect(
    await page.evaluate(() => ({ protocol: location.protocol, secure: isSecureContext })),
  ).toEqual({ protocol: 'https:', secure: true });
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === '__Host-replan_session',
  )!;
  expect({
    secure: cookie?.secure,
    httpOnly: cookie?.httpOnly,
    sameSite: cookie?.sameSite,
    path: cookie?.path,
  }).toEqual({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
  pilot.secrets.push(cookie.value);
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-replan_session');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await expect(page.getByRole('button', { name: 'Reset demo' })).toHaveCount(0);
  await approve(page);
  await pilot.loseResponse();
  await page.getByRole('button', { name: 'Dispatch remaining', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check & recover', exact: true })).toBeVisible();
  expect((await state(page)).plans[0].status).toBe('uncertain');
  await page.getByRole('button', { name: 'Check & recover', exact: true }).click();
  await expect(
    page.getByText('All repair orders have confirmed dispatches.', { exact: false }),
  ).toBeVisible();
  const evidence = await page.evaluate(async () => {
    const response = await fetch('/api/audit');
    return response.json();
  });
  const result = verifyEvidence(evidence);
  expect(result.valid).toBe(true);
  expect(result.metrics.distinctDispatchedOrders).toBe(3);
  expect(result.metrics.unresolvedPlans).toBe(0);
  await page.screenshot({ path: 'test-results/browser/pilot-completed.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('browser enforces viewer permissions, key rotation, and server-side logout', async ({
  page,
  pilot,
}) => {
  await login(page, pilot, pilot.viewer.key);
  await expect(page.getByRole('button', { name: 'Optimize a plan', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/plans', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ strategy: 'optimized' }),
          })
        ).status,
    ),
  ).toBe(403);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace.' })).toBeVisible();
  await login(page, pilot);
  const oldKey = pilot.operator.key;
  await pilot.rotateOperator();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace.' })).toBeVisible();
  expect((await pilot.api('/state', oldKey)).status).toBe(401);
  await login(page, pilot);
  const oldSession = (await page.context().cookies()).find(
    (item) => item.name === '__Host-replan_session',
  )!;
  pilot.secrets.push(oldSession.value);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace.' })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/state')).status)).toBe(401);
  expect(
    (await page.context().cookies()).some((item) => item.name === '__Host-replan_session'),
  ).toBe(false);
  await page.context().addCookies([oldSession]);
  expect(await page.evaluate(async () => (await fetch('/api/state')).status)).toBe(401);
});

test('provider credential rotation holds execution until reconnection, then resumes safely', async ({
  page,
  pilot,
}) => {
  await login(page, pilot);
  await approve(page);
  await pilot.rotateProviderOnly();
  expect((await pilot.api('/ready')).status).toBe(503);
  await page.getByRole('button', { name: 'Dispatch remaining', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check & recover', exact: true })).toBeVisible();
  const interrupted = await state(page);
  expect(interrupted.plans[0].status).toBe('uncertain');
  expect(interrupted.plans[0].actions.every((action) => action.shipment === null)).toBe(true);
  await pilot.reconnectProvider();
  expect((await pilot.api('/ready')).status).toBe(200);
  await page.getByRole('button', { name: 'Check & recover', exact: true }).click();
  await expect(
    page.getByText('All repair orders have confirmed dispatches.', { exact: false }),
  ).toBeVisible();
  const evidence = await page.evaluate(async () => (await fetch('/api/audit')).json());
  expect(verifyEvidence(evidence).valid).toBe(true);
  expect(evidence.world.shipments).toHaveLength(3);
});
