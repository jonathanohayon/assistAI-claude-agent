import assert from 'node:assert/strict';

import { describeOpenAiKey, resolveOpenAiKey } from '../src/openai-key.js';

// OPENAI_API_KEY wins even when a stale REALTIME_API_KEY is still set
const stale = resolveOpenAiKey({ OPENAI_API_KEY: 'sk-new', REALTIME_API_KEY: 'sk-old' });
assert.equal(stale.key, 'sk-new');
assert.deepEqual(stale.ignored, ['REALTIME_API_KEY']);

// the boot line names the variables and never leaks a value
const line = describeOpenAiKey(stale);
assert.equal(line, '[openai-key] source=OPENAI_API_KEY (ignored, remove from env: REALTIME_API_KEY)');
assert.ok(!line.includes('sk-'));

// clean env: no ignored list in the log line
assert.equal(describeOpenAiKey(resolveOpenAiKey({ OPENAI_API_KEY: 'sk-new' })), '[openai-key] source=OPENAI_API_KEY');

// REALTIME_API_KEY alone is no longer accepted: fail fast at boot
assert.throws(() => resolveOpenAiKey({ REALTIME_API_KEY: 'sk-old' }), /OPENAI_API_KEY/);
assert.throws(() => resolveOpenAiKey({ OPENAI_API_KEY: '' }), /OPENAI_API_KEY/);

console.log('ALL OPENAI-KEY TESTS PASSED');
