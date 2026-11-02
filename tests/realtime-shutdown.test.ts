import assert from 'node:assert/strict';

import { closeWithTimeout, createZombieWatch } from '../src/realtime-shutdown.js';

// closes a live session
assert.equal(await closeWithTimeout({ close: async () => {} }, 100), 'closed');

// no session captured (call ended before start)
assert.equal(await closeWithTimeout(null, 100), 'none');

// a hung close never blocks teardown
assert.equal(
  await closeWithTimeout({ close: () => new Promise<void>(() => {}) }, 20),
  'timeout',
);

// a throwing close is reported, not rethrown
assert.equal(
  await closeWithTimeout({ close: async () => { throw new Error('boom'); } }, 100),
  'error',
);

// THE ZOMBIE: an event after shutdown is flagged exactly once
{
  let t = 0;
  const w = createZombieWatch(() => t);
  t = 10; assert.equal(w.onEvent(), false); // during the call
  t = 50; assert.deepEqual(w.markShutdown(), { lastEventAgoMs: 40 });
  t = 60; assert.equal(w.onEvent(), true); // WebSocket survived the call
  t = 70; assert.equal(w.onEvent(), false); // reported once, not 137,470 times
}

console.log('ALL REALTIME-SHUTDOWN TESTS PASSED');
