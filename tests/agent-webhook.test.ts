import assert from 'node:assert/strict';

import { callAgentWebhook, webhookRequestBody } from '../src/agent-webhook.js';
import type { Resolver } from '../src/net/safe-url.js';
import { callIdFromRoomName } from '../src/session-context.js';

// Mock inbound SIP room name: embeds a (fake) caller number.
const ROOM = 'call-+97250000000-abc';
const CALLER_DIGITS = '97250000000';
const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

const bodies: Array<Record<string, unknown>> = [];
const urls: string[] = [];
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  urls.push(String(url));
  bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
  return new Response(JSON.stringify({ reply: 'hello' }), { status: 200 });
}) as typeof fetch;

const config = { url: 'https://agent.example.com/turn' };

// the request body's call_id is the hashed id, never the raw room name
for (const turnId of [0, 1, 2]) {
  const result = await callAgentWebhook(
    config,
    { roomName: ROOM, turnId, language: 'en', transcript: turnId ? 'hi' : '', history: [] },
    { resolve: publicResolver },
  );
  assert.equal(result.reply, 'hello');
}
assert.equal(bodies.length, 3);
for (const body of bodies) {
  assert.equal(body['call_id'], callIdFromRoomName(ROOM));
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(ROOM), 'raw room name leaked');
  assert.ok(!serialized.includes(CALLER_DIGITS), 'caller number leaked');
  // no digit run of the caller number either (any 5+ digit substring)
  for (let i = 0; i + 5 <= CALLER_DIGITS.length; i++) {
    assert.ok(!serialized.includes(CALLER_DIGITS.slice(i, i + 5)), 'caller digit run leaked');
  }
}

// the hash is stable for the same room across turns, and differs between rooms
assert.equal(bodies[0]?.['call_id'], bodies[2]?.['call_id']);
assert.equal(
  webhookRequestBody({ roomName: ROOM, turnId: 7, language: 'fr', transcript: 'x', history: [] }).call_id,
  callIdFromRoomName(ROOM),
);
assert.notEqual(callIdFromRoomName(ROOM), callIdFromRoomName('call-+97250000001-abc'));
assert.match(String(bodies[0]?.['call_id']), /^[0-9a-f]{16}$/);

// an unsafe URL is a failed turn and sends no request
const before = urls.length;
const refused = await callAgentWebhook(
  { url: 'https://agent.example.com/turn' },
  { roomName: ROOM, turnId: 3, language: 'en', transcript: 'hi', history: [] },
  { resolve: async () => [{ address: '169.254.169.254', family: 4 }] },
);
assert.equal(refused.reply, null);
assert.equal(refused.failure, 'unsafe_url');
const plainHttp = await callAgentWebhook(
  { url: 'http://agent.example.com/turn' },
  { roomName: ROOM, turnId: 4, language: 'en', transcript: 'hi', history: [] },
  { resolve: publicResolver },
);
assert.equal(plainHttp.failure, 'unsafe_url');
assert.equal(urls.length, before, 'a refused URL must not be fetched');

// a DNS failure is a network failure, not a request
const dnsDown = await callAgentWebhook(
  config,
  { roomName: ROOM, turnId: 5, language: 'en', transcript: 'hi', history: [] },
  { resolve: async () => { throw new Error('ENOTFOUND'); } },
);
assert.equal(dnsDown.failure, 'network');
assert.equal(urls.length, before);

console.log('agent-webhook: ok');
