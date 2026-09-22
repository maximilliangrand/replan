import assert from 'node:assert/strict';
const base = process.argv[2] ?? 'http://127.0.0.1:4310';
async function api(path, body) {
  const response = await fetch(base + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
for (let i = 0; ; i++) {
  try {
    if ((await fetch(base + '/api/health')).ok) break;
  } catch {}
  if (i === 60) throw new Error('Application did not start');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal((await fetch(base)).status, 200, 'Built frontend is served');
await api('/demo/reset', {});
const proposal = (await api('/plans', { strategy: 'optimized' })).plans[0];
await api(`/plans/${proposal.id}/approve`, { hash: proposal.hash });
await api('/demo/fault', { fault: 'lost_response' });
const unknown = await api(`/plans/${proposal.id}/execute`, {});
assert.equal(unknown.plans[0].status, 'uncertain');
assert.equal(unknown.world.shipments.length, 1);
const recovered = await api(`/plans/${proposal.id}/recover`, {});
assert.equal(recovered.plans[0].status, 'completed');
assert.equal(recovered.world.shipments.length, 3);
console.log(
  'Container smoke passed: frontend, solver, PostgreSQL, lost response, reconciliation, three unique dispatches.',
);
