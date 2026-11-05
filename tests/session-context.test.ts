import assert from 'node:assert/strict';

import { callIdFromRoomName, currentCallId, enterSession, runWithSession } from '../src/session-context.js';

// web requests made inside a call carry x-call-id; outside a call they don't
const seen: Array<Record<string, string>> = [];
process.env['APP_URL'] = 'https://example.test';
process.env['INTERNAL_SECRET'] = 'test-secret';
globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
  seen.push({ ...(init?.headers ?? {}) });
  return new Response('{}', { status: 200 });
}) as typeof fetch;

const { webGet, webPost } = await import('../src/web-api.js');

assert.equal(currentCallId(), undefined);
await webPost('/api/x', {});
assert.equal(seen[0]?.['x-call-id'], undefined);

await runWithSession({ callId: 'room-A' }, async () => {
  assert.equal(currentCallId(), 'room-A');
  await webPost('/api/calendar/book', {});
  // propagates through later async continuations (tool calls come later in the call)
  await new Promise((r) => setTimeout(r, 5));
  await webGet('/api/agent/config');
});
assert.equal(seen[1]?.['x-call-id'], 'room-A');
assert.equal(seen[2]?.['x-call-id'], 'room-A');
assert.equal(seen[1]?.['x-internal-secret'], 'test-secret');

// two overlapping calls keep their own id
await Promise.all([
  runWithSession({ callId: 'room-B' }, async () => {
    await new Promise((r) => setTimeout(r, 10));
    await webPost('/api/b', {});
  }),
  runWithSession({ callId: 'room-C' }, async () => {
    await webPost('/api/c', {});
  }),
]);
const byPath = (n: number) => seen[n]?.['x-call-id'];
assert.deepEqual([byPath(3), byPath(4)].sort(), ['room-B', 'room-C']);

// remoteLog stamps metadata.callId (and keeps an explicit one)
const bodies: unknown[] = [];
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  bodies.push(JSON.parse(init?.body ?? '{}'));
  return new Response('{}', { status: 200 });
}) as typeof fetch;
const { remoteLog } = await import('../src/remote-log.js');
const origLog = console.log;
console.log = () => {};
await runWithSession({ callId: 'room-D' }, async () => {
  await remoteLog('agent', 'call_transfer', 'm', 'info', { ok: true });
});
console.log = origLog;
assert.equal((bodies[0] as { metadata: { callId: string } }).metadata.callId, 'room-D');

// enterSession works for the rest of the chain (how agent.ts entry() uses it)
await (async () => {
  enterSession({ callId: 'room-E' });
  await Promise.resolve();
  assert.equal(currentCallId(), 'room-E');
})();

// call id = hash of the room name: SIP room names embed the caller's number
{
  const room = 'call-_+972500000000_AbC123xyz'; // mock LiveKit SIP room name
  const id = callIdFromRoomName(room);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(callIdFromRoomName(room), id, 'stable per call');
  assert.notEqual(callIdFromRoomName('call-_+972500000001_AbC123xyz'), id);
  // no digit run from the room name (4+ digits) survives in the id
  for (const run of room.match(/\d{4,}/g) ?? []) {
    for (let i = 0; i + 4 <= run.length; i++) {
      assert.ok(!id.includes(run.slice(i, i + 4)), `id leaks digits ${run.slice(i, i + 4)}`);
    }
  }
  assert.ok(!id.includes('972'), 'no country code');
}

console.log('ALL SESSION-CONTEXT TESTS PASSED');
