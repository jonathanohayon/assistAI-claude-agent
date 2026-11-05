import assert from 'node:assert/strict';

import { checkKeys, keyStateFromStatus } from '../src/heartbeat.js';

// status -> key state
assert.equal(keyStateFromStatus('openai', 200), 'ok');
assert.equal(keyStateFromStatus('openai', 401), 'invalid');
assert.equal(keyStateFromStatus('xai', 403), 'invalid');
assert.equal(keyStateFromStatus('gemini', 400), 'invalid'); // Gemini: bad key = 400
assert.equal(keyStateFromStatus('openai', 400), 'unreachable');
assert.equal(keyStateFromStatus('xai', 503), 'unreachable'); // an outage isn't a dead key

async function main() {
  process.env['OPENAI_API_KEY'] = 'k1';
  process.env['GOOGLE_API_KEY'] = 'k2';
  delete process.env['XAI_API_KEY'];
  const seen: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push(String(url));
    // the key travels only in headers, never in the URL
    assert.ok(!String(url).includes('k1') && !String(url).includes('k2'));
    const h = (init?.headers ?? {}) as Record<string, string>;
    const status = h['x-goog-api-key'] === 'k2' ? 400 : 200;
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  const keys = await checkKeys(fake);
  assert.deepEqual(keys, { openai: 'ok', gemini: 'invalid', xai: 'missing' });
  assert.equal(seen.length, 2); // no call without a key

  const down = (async () => {
    throw new Error('network');
  }) as unknown as typeof fetch;
  assert.equal((await checkKeys(down)).openai, 'unreachable');
  console.log('ALL HEARTBEAT TESTS PASSED');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
