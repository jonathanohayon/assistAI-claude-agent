import assert from 'node:assert/strict';

import { XAI_USD_PER_MINUTE, computeCallCostUsd, computeRealtimeCostUsd } from '../src/pricing.js';

const usage = { inAudio: 1_000_000, inText: 0, inCachedAudio: 0, inCachedText: 0, outAudio: 1_000_000, outText: 0 };

// gpt-realtime-2.1 is priced like gpt-realtime-2 (OpenAI pricing page)
assert.equal(computeRealtimeCostUsd(usage, 'gpt-realtime-2.1'), computeRealtimeCostUsd(usage, 'gpt-realtime-2'));
assert.equal(computeRealtimeCostUsd(usage, 'gpt-realtime-2'), 96); // 32 in + 64 out
// mini is cheaper (model-page rates, unverified on the pricing page)
assert.equal(computeRealtimeCostUsd(usage, 'gpt-realtime-2.1-mini'), 30);
// an unknown model still falls back to the gpt-realtime-2 rates (prod default)
assert.equal(computeRealtimeCostUsd(usage, 'some-future-model'), 96);

// per engine
const none = { inAudio: 0, inText: 0, inCachedAudio: 0, inCachedText: 0, outAudio: 0, outText: 0 };
// OpenAI: exactly the token pricing used before (no prod change)
assert.deepEqual(
  computeCallCostUsd({ provider: 'openai', model: 'gpt-realtime-2', tokens: usage, sessionSeconds: 60 }),
  { costUsd: 96, pricing: 'tokens' },
);
// Grok: per connected minute, tokens ignored (the plugin reports none)
assert.equal(XAI_USD_PER_MINUTE, 0.08);
assert.deepEqual(
  computeCallCostUsd({ provider: 'xai', model: 'grok-voice-3.0', tokens: none, sessionSeconds: 90 }),
  { costUsd: 0.12, pricing: 'per_minute' },
);
assert.equal(computeCallCostUsd({ provider: 'xai', model: 'grok-voice-3.0', tokens: none, sessionSeconds: -5 }).costUsd, 0);
// Gemini 3.8 Live: 3 audio in, 0.75 text in, 12 audio out, 4.50 text out per 1M
assert.deepEqual(
  computeCallCostUsd({
    provider: 'gemini',
    model: 'gemini-3.8-live',
    tokens: { inAudio: 1_000_000, inText: 1_000_000, inCachedAudio: 0, inCachedText: 0, outAudio: 1_000_000, outText: 1_000_000 },
    sessionSeconds: 60,
  }),
  { costUsd: 20.25, pricing: 'tokens' },
);
// never the OpenAI rate card for another engine
assert.notEqual(
  computeCallCostUsd({ provider: 'gemini', model: 'gemini-3.8-live', tokens: usage, sessionSeconds: 60 }).costUsd,
  96,
);

console.log('ALL PRICING TESTS PASSED');
