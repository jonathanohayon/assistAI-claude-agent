import assert from 'node:assert/strict';

import { OPENER_TIMEOUT_MS, fetchOpenerPcm } from '../src/greeting-player.js';

process.env['APP_URL'] = 'https://web.example.test';
process.env['INTERNAL_SECRET'] = 'test-secret';

// A fake web: headers arrive fast, the PCM body takes `bodyDelayMs` to stream
// (what a ~400 KB opener over the public domain looks like). Honours abort.
function fakeWeb(bodyDelayMs: number, status = 200): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const t = setTimeout(() => {
          controller.enqueue(new Uint8Array(4800));
          controller.close();
        }, bodyDelayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          controller.error(signal.reason);
        });
      },
    });
    return new Response(status === 200 ? body : null, {
      status,
      headers: {
        'x-sample-rate': '24000',
        'x-opener-text': Buffer.from('שלום', 'utf8').toString('base64'),
      },
    });
  }) as typeof fetch;
}

async function main() {
  const realFetch = globalThis.fetch;
  try {
    // THE BUG: a body that takes 800 ms was dropped by the old 600 ms budget
    globalThis.fetch = fakeWeb(800);
    assert.equal(await fetchOpenerPcm('+15550000002', 600), null);

    // with the new default budget the same response is played
    assert.ok(OPENER_TIMEOUT_MS >= 2000);
    globalThis.fetch = fakeWeb(800);
    const ok = await fetchOpenerPcm('+15550000002');
    assert.ok(ok);
    assert.equal(ok?.pcm.length, 4800);
    assert.equal(ok?.sampleRate, 24000);
    assert.equal(ok?.text, 'שלום');

    // no opener (204) -> null, the model greets
    globalThis.fetch = fakeWeb(0, 204);
    assert.equal(await fetchOpenerPcm('+15550000002'), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log('ALL GREETING-PLAYER TESTS PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
