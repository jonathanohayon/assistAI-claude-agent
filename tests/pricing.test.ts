import assert from 'node:assert/strict';

import { computeRealtimeCostUsd } from '../src/pricing.js';

const usage = { inAudio: 1_000_000, inText: 0, inCachedAudio: 0, inCachedText: 0, outAudio: 1_000_000, outText: 0 };

// gpt-realtime-2.1 is priced like gpt-realtime-2 (OpenAI pricing page)
assert.equal(computeRealtimeCostUsd(usage, 'gpt-realtime-2.1'), computeRealtimeCostUsd(usage, 'gpt-realtime-2'));
assert.equal(computeRealtimeCostUsd(usage, 'gpt-realtime-2'), 96); // 32 in + 64 out
// mini is cheaper (model-page rates, unverified on the pricing page)
assert.equal(computeRealtimeCostUsd(usage, 'gpt-realtime-2.1-mini'), 30);
// an unknown model still falls back to the gpt-realtime-2 rates (prod default)
assert.equal(computeRealtimeCostUsd(usage, 'some-future-model'), 96);

console.log('ALL PRICING TESTS PASSED');
