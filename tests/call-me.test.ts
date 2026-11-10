// "Call me" (V7b) origin on the worker: detection, config path, routing.
// Mock ids/numbers only. Run with:  npx tsx tests/call-me.test.ts
import assert from 'node:assert/strict';

import { callMeFromRoomName, detectOrigin, parseCallMeMeta } from '../src/origin.js';
import { transferEligible } from '../src/transfer.js';

const UID = '00000000-0000-0000-0000-00000000000a';
const meta = JSON.stringify({ source: 'call_me', userId: UID });

// metadata + room name parsing
assert.deepEqual(parseCallMeMeta(meta), { kind: 'call_me', userId: UID });
assert.equal(parseCallMeMeta(JSON.stringify({ source: 'web', userId: UID })), null);
assert.equal(parseCallMeMeta(JSON.stringify({ source: 'call_me' })), null, 'userId required');
assert.equal(parseCallMeMeta('not json'), null);
assert.deepEqual(callMeFromRoomName(`callme__${UID}__loyw3v28`), { kind: 'call_me', userId: UID });
assert.equal(callMeFromRoomName('campaign__c__k__1'), null);
assert.equal(callMeFromRoomName('callme__'), null);

// detectOrigin: the owner's leg is a SIP participant WITH trunk attributes;
// call_me must win, or the call would be taken for an inbound one
type P = { identity: string; attributes: Record<string, string>; metadata?: string };
const ctxWith = (opts: { jobMeta?: string; room?: string; participants?: P[] }) =>
  ({
    job: { metadata: opts.jobMeta ?? '' },
    room: { name: opts.room ?? 'room-x', remoteParticipants: new Map((opts.participants ?? []).map((p) => [p.identity, p])) },
  }) as never;
const sipLeg: P = {
  identity: 'callee-callme',
  attributes: { 'sip.phoneNumber': '+972500000000', 'sip.trunkPhoneNumber': '+97220000000' },
  metadata: meta,
};

assert.deepEqual(await detectOrigin(ctxWith({ jobMeta: meta }), 50), { kind: 'call_me', userId: UID }, 'job metadata');
assert.deepEqual(await detectOrigin(ctxWith({ room: `callme__${UID}__x` }), 50), { kind: 'call_me', userId: UID }, 'room name');
assert.deepEqual(await detectOrigin(ctxWith({ participants: [sipLeg] }), 50), { kind: 'call_me', userId: UID }, 'participant metadata beats SIP attributes');
// a real inbound SIP call is unchanged
assert.deepEqual(
  await detectOrigin(ctxWith({ participants: [{ ...sipLeg, metadata: '' }] }), 50),
  { kind: 'sip', calledNumber: '+97220000000', channel: 'pstn' },
);

// config path: the receptionist persona by userId (same as the web test)
{
  const seen: string[] = [];
  process.env['APP_URL'] = 'https://example.test';
  process.env['INTERNAL_SECRET'] = 'test-secret';
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ instructions: 'x' }), { status: 200 });
  }) as typeof fetch;
  const { fetchConfig } = await import('../src/config-fetcher.js');
  const log = console.log;
  console.log = () => {};
  await fetchConfig({ kind: 'call_me', userId: UID });
  console.log = log;
  assert.equal(seen[0], `https://example.test/api/agent/config?userId=${UID}`);
}

// no transfer on a call-me (it's the owner testing their own line)
assert.equal(transferEligible({ originKind: 'call_me', channel: undefined, transferNumber: '+97230000000' }), false);

console.log('ALL CALL-ME TESTS PASSED');
