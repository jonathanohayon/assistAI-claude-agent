import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type https from 'node:https';
import { Readable } from 'node:stream';

import { callAgentWebhook, MAX_RESPONSE_BYTES, webhookRequestBody } from '../src/agent-webhook.js';
import { checkSafeUrl, type ResolvedAddress, type Resolver } from '../src/net/safe-url.js';
import { callIdFromRoomName } from '../src/session-context.js';

// Mock inbound SIP room name: embeds a (fake) caller number.
const ROOM = 'call-+97250000000-abc';
const CALLER_DIGITS = '97250000000';
const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const PRIVATE: ResolvedAddress = { address: '10.0.0.5', family: 4 };
const publicResolver: Resolver = async () => [PUBLIC];
const params = (turnId: number) => ({ roomName: ROOM, turnId, language: 'en', transcript: 'hi', history: [] });
const config = { url: 'https://agent.example.com/turn' };

// Fake https.request. Like a real socket, it calls options.lookup before
// connecting, and only "sends" the body once the lookup has succeeded.
interface Sent { hostname: string; connectedTo: string; body: string }
const sent: Sent[] = [];
let respond: { status: number; body: string | Buffer } = { status: 200, body: JSON.stringify({ reply: 'hello' }) };
let hang = false;

const fakeRequest = ((options: https.RequestOptions, onResponse: (res: Readable & { statusCode?: number }) => void) => {
  const req = new EventEmitter() as EventEmitter & { end: (b: string) => void; destroy: () => void };
  req.destroy = () => {};
  req.end = (body: string) => {
    if (hang) return;
    const lookup = options.lookup as unknown as (
      h: string, o: { all: boolean }, cb: (err: Error | null, a: ResolvedAddress[]) => void,
    ) => void;
    lookup(String(options.hostname), { all: true }, (err, addresses) => {
      if (err) { req.emit('error', err); return; }
      sent.push({ hostname: String(options.hostname), connectedTo: addresses[0]!.address, body });
      const res = Readable.from([Buffer.from(respond.body)]) as Readable & { statusCode?: number };
      res.statusCode = respond.status;
      onResponse(res);
    });
  };
  return req;
}) as unknown as typeof https.request;

const deps = (resolve: Resolver = publicResolver) => ({ resolve, request: fakeRequest });

// the request body's call_id is the hashed id, never the raw room name
for (const turnId of [0, 1, 2]) {
  const result = await callAgentWebhook(config, { ...params(turnId), transcript: turnId ? 'hi' : '' }, deps());
  assert.equal(result.reply, 'hello');
}
assert.equal(sent.length, 3);
const bodies = sent.map((s) => JSON.parse(s.body) as Record<string, unknown>);
for (const s of sent) {
  assert.equal(s.hostname, 'agent.example.com', 'Host / SNI stay the hostname');
  assert.equal(s.connectedTo, PUBLIC.address, 'socket connects to the checked address');
  assert.equal((JSON.parse(s.body) as Record<string, unknown>)['call_id'], callIdFromRoomName(ROOM));
  assert.ok(!s.body.includes(ROOM), 'raw room name leaked');
  for (let i = 0; i + 5 <= CALLER_DIGITS.length; i++) {
    assert.ok(!s.body.includes(CALLER_DIGITS.slice(i, i + 5)), 'caller digit run leaked');
  }
}

// the hash is stable for the same room across turns, and differs between rooms
assert.equal(bodies[0]?.['call_id'], bodies[2]?.['call_id']);
assert.equal(webhookRequestBody(params(7)).call_id, callIdFromRoomName(ROOM));
assert.notEqual(callIdFromRoomName(ROOM), callIdFromRoomName('call-+97250000001-abc'));
assert.match(String(bodies[0]?.['call_id']), /^[0-9a-f]{16}$/);

// DNS rebinding: public at the pre-check, private at connect → refused, no bytes sent
{
  let calls = 0;
  const rebinding: Resolver = async () => (++calls === 1 ? [PUBLIC] : [PRIVATE]);
  assert.deepEqual(await checkSafeUrl(config.url, rebinding), { ok: true });
  const before = sent.length;
  const result = await callAgentWebhook(config, params(3), deps(rebinding));
  assert.equal(result.failure, 'unsafe_url');
  assert.equal(result.reply, null);
  assert.equal(calls, 2, 'the connect-time lookup re-resolved');
  assert.equal(sent.length, before, 'no bytes sent');
}

// one private record among public ones is refused at connect
{
  const before = sent.length;
  const result = await callAgentWebhook(config, params(4), deps(async () => [PUBLIC, PRIVATE]));
  assert.equal(result.failure, 'unsafe_url');
  assert.equal(sent.length, before);
}

// URL-shape refusals never reach the transport
{
  const before = sent.length;
  let resolved = 0;
  const counting: Resolver = async () => { resolved++; return [PUBLIC]; };
  for (const url of ['http://agent.example.com/turn', 'https://localhost/turn', 'https://169.254.169.254/latest', 'https://[::1]/']) {
    const result = await callAgentWebhook({ url }, params(5), deps(counting));
    assert.equal(result.failure, 'unsafe_url', url);
  }
  assert.equal(resolved, 0);
  assert.equal(sent.length, before);
}

// a DNS failure is a network failure, no request
{
  const before = sent.length;
  const result = await callAgentWebhook(config, params(6), deps(async () => { throw new Error('ENOTFOUND'); }));
  assert.equal(result.failure, 'network');
  assert.equal(sent.length, before);
}

// no redirects: a 3xx is a failed turn
respond = { status: 302, body: '' };
assert.equal((await callAgentWebhook(config, params(7), deps())).failure, 'http');
respond = { status: 500, body: '' };
assert.equal((await callAgentWebhook(config, params(8), deps())).status, 500);

// response size cap → 'shape'
respond = { status: 200, body: Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x61) };
assert.equal((await callAgentWebhook(config, params(9), deps())).failure, 'shape');
respond = { status: 200, body: 'not json' };
assert.equal((await callAgentWebhook(config, params(10), deps())).failure, 'shape');

// the turn budget still applies
hang = true;
const slow = await callAgentWebhook(config, params(11), deps());
assert.equal(slow.failure, 'timeout');
hang = false;

// Real node:https request, same guard: the injected resolver answers private,
// so the lookup refuses before any socket connects (no network touched).
{
  let calls = 0;
  const result = await callAgentWebhook(config, params(12), {
    resolve: async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; },
  });
  assert.equal(result.failure, 'unsafe_url');
  assert.ok(calls >= 1, 'real https.request used the guarded lookup');
}

console.log('agent-webhook: ok');
