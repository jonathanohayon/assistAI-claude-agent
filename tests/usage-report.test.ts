import assert from 'node:assert/strict';

import { buildUsagePayload } from '../src/usage-report.js';

const base = {
  callId: 'room_1',
  model: 'gpt-realtime-2',
  inputTokensTotal: 1000,
  cachedInputTokens: 400,
  outputTokens: 250,
  costUsd: 0.0123,
};

// sends only the uncached part as inputTokens, so cached tokens are not billed twice
{
  const p = buildUsagePayload(base)!;
  assert.equal(p['inputTokens'], 600);
  assert.equal(p['cachedTokens'], 400);
  assert.equal(p['outputTokens'], 250);
  assert.equal(p['callId'], 'room_1');
  assert.equal(p['costUsd'], 0.0123);
}

// skips a call that never reached the model (the route rejects all-zero bodies)
assert.equal(
  buildUsagePayload({ ...base, inputTokensTotal: 0, cachedInputTokens: 0, outputTokens: 0 }),
  null,
);

// clamps a cached count larger than the total instead of going negative
{
  const p = buildUsagePayload({ ...base, cachedInputTokens: 5000 })!;
  assert.equal(p['inputTokens'], 0);
  assert.equal(p['cachedTokens'], 1000);
}

// forwards the tenant hints only when present
{
  const sip = buildUsagePayload({ ...base, toNumber: '+97225551234' })!;
  assert.equal(sip['toNumber'], '+97225551234');
  assert.equal('userId' in sip, false);
  const web = buildUsagePayload({ ...base, userId: 'u_1', toNumber: undefined })!;
  assert.equal(web['userId'], 'u_1');
  assert.equal('toNumber' in web, false);
}

console.log('ALL USAGE-REPORT TESTS PASSED');
