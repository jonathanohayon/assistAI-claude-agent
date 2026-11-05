import assert from 'node:assert/strict';

import { buildUsagePayload } from '../src/usage-report.js';

const base = {
  callId: 'room_1',
  model: 'gpt-realtime-2',
  inputTokensTotal: 1000,
  cachedInputTokens: 400,
  outputTokens: 250,
  costUsd: 0.0123,
  durationSeconds: 95.4,
};

// sends only the uncached part as inputTokens, so cached tokens are not billed twice
{
  const p = buildUsagePayload(base)!;
  assert.equal(p['inputTokens'], 600);
  assert.equal(p['cachedTokens'], 400);
  assert.equal(p['outputTokens'], 250);
  assert.equal(p['callId'], 'room_1');
  assert.equal(p['costUsd'], 0.0123);
  assert.equal(p['durationSeconds'], 95);
}

// skips a call that never reached the model: no tokens and no cost
assert.equal(
  buildUsagePayload({ ...base, inputTokensTotal: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 }),
  null,
);

// Grok (per-minute engine): no tokens but a real cost -> still reported, with
// its provider and real model
{
  const grok = buildUsagePayload({
    ...base,
    provider: 'xai',
    model: 'grok-voice-3.0',
    inputTokensTotal: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0.12,
  })!;
  assert.ok(grok);
  assert.equal(grok['provider'], 'xai');
  assert.equal(grok['model'], 'grok-voice-3.0');
  assert.equal(grok['costUsd'], 0.12);
  assert.equal(grok['inputTokens'], 0);
}
// OpenAI payloads without a provider stay exactly as before
assert.equal('provider' in buildUsagePayload(base)!, false);

// clamps a cached count larger than the total instead of going negative
{
  const p = buildUsagePayload({ ...base, cachedInputTokens: 5000 })!;
  assert.equal(p['inputTokens'], 0);
  assert.equal(p['cachedTokens'], 1000);
}

// forwards the tenant hints only when present
{
  const sip = buildUsagePayload({ ...base, toNumber: '+97220000000' })!;
  assert.equal(sip['toNumber'], '+97220000000');
  assert.equal('userId' in sip, false);
  const web = buildUsagePayload({ ...base, userId: 'u_1', toNumber: undefined })!;
  assert.equal(web['userId'], 'u_1');
  assert.equal('toNumber' in web, false);
}

console.log('ALL USAGE-REPORT TESTS PASSED');
