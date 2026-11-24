// Connectors B3: `clientAgentReached` and `connectorRoute` in /api/calls/end
// (src/client-agent-reach.ts, src/post-call.ts, src/config-fetcher.ts,
// src/brain-mode.ts, tools/client-agent.ts). Mock ids, urls and data only;
// the fake web is a local HTTP server on 127.0.0.1, the customer's agent is
// an injected `ask` (no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { clientAgentOpening, runClientAgentVoiceTurn } from '../src/brain-mode.js';
import {
  callEndExtras,
  clientAgentReachLogLine,
  connectorRouteField,
  createClientAgentReachTracker,
} from '../src/client-agent-reach.js';
import type { askClientAgent, ClientAgentResult } from '../src/client-agent.js';
import { buildCallEndPayload, postCallEnd, redactForLog } from '../src/post-call.js';
import { runWithSession } from '../src/session-context.js';
import { makeClientAgentTools } from '../tools/client-agent.js';

const SECRET = 'mock-secret-do-not-log';
const AGENT_URL = 'https://agent.example.test/hook/tok-in-path?k=mock-query-token';
const ROUTE_TOKEN = 'mock.connector-route.signed-token-v1';
const ENDPOINT = { url: AGENT_URL, secret: SECRET };

// ── Log capture: everything printed during the run is checked at the end.
const logged: string[] = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
const capture = (...a: unknown[]) => {
  logged.push(a.map(String).join(' '));
};
console.log = capture;
console.warn = capture;
console.error = capture;
const say = (s: string) => orig.log(s);

// ── Fake web: serves the session config, records /api/calls/end bodies.
let webConfig: Record<string, unknown> = {};
let webStatus = 200;
const callEndBodies: string[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = req.url ?? '';
    if (path.startsWith('/api/agent/config')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(webConfig));
      return;
    }
    if (path === '/api/calls/end') callEndBodies.push(body);
    res.writeHead(webStatus);
    res.end('{}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env['APP_URL'] = BASE;
process.env['INTERNAL_SECRET'] = 'mock-internal';

// Fake customer agent: scripted results, one per request.
const ok = (answer: string): ClientAgentResult => ({ answer, elapsedMs: 5, status: 200 });
const fail = (failure: NonNullable<ClientAgentResult['failure']>): ClientAgentResult => ({ answer: null, elapsedMs: 2500, failure });
function scripted(results: ClientAgentResult[]): typeof askClientAgent {
  let i = 0;
  return async () => results[i++] ?? fail('timeout');
}

type Tool = { execute: (a: unknown, o: unknown) => Promise<string> };
function leadTool(reach: ReturnType<typeof createClientAgentReachTracker>, ask: typeof askClientAgent): Tool {
  return makeClientAgentTools({
    webhook: ENDPOINT,
    getCallId: () => 'mock-call-id',
    getLanguage: () => 'en',
    getCallerSaid: () => 'when are you open',
    getHistory: () => [],
    ask,
    reach,
  }).ask_client_agent as unknown as Tool;
}

async function voiceTurn(reach: ReturnType<typeof createClientAgentReachTracker>, ask: typeof askClientAgent, turnId = 1) {
  const spoken: string[] = [];
  const outcome = await runClientAgentVoiceTurn({
    endpoint: ENDPOINT,
    callId: 'mock-call-id',
    turnId,
    language: 'en',
    callerSaid: 'when are you open',
    history: [],
    speak: async (t) => {
      spoken.push(t);
    },
    ask,
    stallMs: 10_000,
    log: () => {},
    reach,
  });
  return { outcome, spoken };
}

// ── 1. tracker semantics ─────────────────────────────────────────────────
{
  const t = createClientAgentReachTracker();
  assert.equal(t.reached, undefined, 'no attempt → undefined (key omitted)');
  t.record(false);
  assert.equal(t.reached, false, 'one failed attempt → false');
  t.record(true);
  assert.equal(t.reached, true, 'a success after a failure → true');
  t.record(false);
  assert.equal(t.reached, true, 'a later failure does not undo a success');
}

// ── 2. lead mode (ask_client_agent tool) ─────────────────────────────────
{
  const reach = createClientAgentReachTracker();
  const tool = leadTool(reach, scripted([ok('Open 9 to 18.')]));
  assert.match(await tool.execute({ question: 'Opening hours?' }, {}), /«Open 9 to 18\.»/);
  assert.equal(reach.reached, true, 'lead: an answer → true');
}
{
  const reach = createClientAgentReachTracker();
  const tool = leadTool(reach, scripted([fail('timeout'), fail('timeout'), fail('timeout')]));
  for (let i = 0; i < 3; i++) assert.match(await tool.execute({ question: 'q' }, {}), /did not answer/);
  assert.equal(reach.reached, false, 'lead: all timeouts → false');
}
{
  const reach = createClientAgentReachTracker();
  leadTool(reach, scripted([ok('unused')]));
  assert.equal(reach.reached, undefined, 'lead: tool never called → absent');
}
{
  const reach = createClientAgentReachTracker();
  const tool = leadTool(reach, async () => {
    throw new Error('boom');
  });
  assert.match(await tool.execute({ question: 'q' }, {}), /did not answer/);
  assert.equal(reach.reached, false, 'lead: a throwing ask counts as a failed attempt');
}
{
  const reach = createClientAgentReachTracker();
  const tool = leadTool(reach, scripted([fail('http'), ok('Yes, in stock.')]));
  await tool.execute({ question: 'q1' }, {});
  await tool.execute({ question: 'q2' }, {});
  assert.equal(reach.reached, true, 'lead mix: one fail then one success → true');
}

// ── 3. voice mode (verbatim turns + opening) ─────────────────────────────
{
  const reach = createClientAgentReachTracker();
  const { outcome, spoken } = await voiceTurn(reach, scripted([ok('We open at 9.')]));
  assert.equal(outcome, 'answered');
  assert.deepEqual(spoken, ['We open at 9.']);
  assert.equal(reach.reached, true, 'voice: a reply spoken → true');
}
{
  const reach = createClientAgentReachTracker();
  const ask = scripted([fail('timeout'), fail('network'), fail('unsafe_url')]);
  for (let i = 1; i <= 3; i++) await voiceTurn(reach, ask, i);
  assert.equal(reach.reached, false, 'voice: all fail → false');
}
{
  const reach = createClientAgentReachTracker();
  const ask = scripted([fail('shape'), ok('Booked for Tuesday.')]);
  await voiceTurn(reach, ask, 1);
  await voiceTurn(reach, ask, 2);
  assert.equal(reach.reached, true, 'voice mix: one fail then one success → true');
}
{
  const reach = createClientAgentReachTracker();
  const ask: typeof askClientAgent = async () => {
    throw new Error('boom');
  };
  const { outcome } = await voiceTurn(reach, ask);
  assert.equal(outcome, 'error');
  assert.equal(reach.reached, false, 'voice: a throwing ask counts as a failed attempt');
}
{
  const reach = createClientAgentReachTracker();
  const answer = await clientAgentOpening({ endpoint: ENDPOINT, callId: 'c', language: 'en', ask: scripted([ok('Hello, Mock Salon.')]), log: () => {}, reach });
  assert.equal(answer, 'Hello, Mock Salon.');
  assert.equal(reach.reached, true, 'voice: an opening answer → true');
  const reach2 = createClientAgentReachTracker();
  await clientAgentOpening({ endpoint: ENDPOINT, callId: 'c', language: 'en', ask: scripted([fail('timeout')]), log: () => {}, reach: reach2 });
  assert.equal(reach2.reached, false, 'voice: a failed opening → false');
}

// ── 4. connectorRoute: read from the session config ──────────────────────
{
  assert.deepEqual(connectorRouteField(ROUTE_TOKEN), { connectorRoute: ROUTE_TOKEN }, 'string → echoed unchanged');
  assert.deepEqual(connectorRouteField(undefined), {}, 'absent → absent');
  for (const bad of [42, true, null, {}, ['x'], '']) {
    assert.deepEqual(connectorRouteField(bad), {}, `non-string ${JSON.stringify(bad)} → ignored`);
  }

  const { fetchConfig } = await import('../src/config-fetcher.js');
  const origin = { kind: 'web', userId: 'mock-user-1' } as never;
  const base = { instructions: 'Mock persona', greetingInstructions: '', agentName: 'Mock', voice: 'marin', features: { calendar: false } };
  webConfig = base;
  const absent = await fetchConfig(origin);
  assert.equal('connectorRoute' in absent, false, 'not served → absent from the config');
  webConfig = { ...base, connectorRoute: ROUTE_TOKEN };
  const served = await fetchConfig(origin);
  assert.equal(served.connectorRoute, ROUTE_TOKEN, 'served → read unchanged');
  const { connectorRoute: _drop, ...rest } = served;
  assert.deepEqual(rest, absent, 'connectorRoute adds one key, nothing else changes');
  webConfig = { ...base, connectorRoute: 12345 };
  assert.deepEqual(await fetchConfig(origin), absent, 'non-string → exactly the absent config');
}

// ── 5. /api/calls/end payload ────────────────────────────────────────────
const TRANSCRIPT = [
  { role: 'user' as const, text: 'Hello' },
  { role: 'assistant' as const, text: 'Hi, Mock Salon.' },
];
const ENGINE = { provider: 'openai', model: 'mock-realtime' };
// The exact JSON a call with no client agent and no connector sent before
// this change (same keys, same order). Must never change.
const PINNED_NO_CLIENT_AGENT =
  '{"callId":"mock-call-id","fromNumber":"+15550000001","toNumber":"+15550000002",' +
  '"transcript":[{"role":"user","text":"Hello"},{"role":"assistant","text":"Hi, Mock Salon."}],' +
  '"channel":"pstn","durationSeconds":42,"realtimeProvider":"openai","realtimeModel":"mock-realtime"}';

async function sendCallEnd(extras: Parameters<typeof postCallEnd>[7]): Promise<string> {
  const before = callEndBodies.length;
  await runWithSession({ callId: 'mock-call-id' }, () =>
    postCallEnd(TRANSCRIPT, '+15550000001', '+15550000002', undefined, 'pstn', 42.4, ENGINE, extras),
  );
  assert.equal(callEndBodies.length, before + 1, 'one /api/calls/end request');
  return callEndBodies[callEndBodies.length - 1]!;
}

{
  // No client agent, no connector: the tracker was never touched.
  const reach = createClientAgentReachTracker();
  const extras = callEndExtras(reach.reached, undefined);
  assert.equal(extras, undefined, 'nothing to add → no extras at all');
  assert.equal(await sendCallEnd(extras), PINNED_NO_CLIENT_AGENT, 'no client agent → byte-identical payload');
  assert.equal(await sendCallEnd(undefined), PINNED_NO_CLIENT_AGENT, 'old call shape (no extras arg) → same bytes');
  assert.equal(clientAgentReachLogLine(reach.reached, undefined), null, 'no client agent → no reach log line');
  // Configured but never asked: also omitted.
  assert.equal(await sendCallEnd(callEndExtras(undefined, undefined)), PINNED_NO_CLIENT_AGENT, 'never asked → absent');
}
{
  const body = JSON.parse(await sendCallEnd(callEndExtras(true, undefined)));
  assert.equal(body.clientAgentReached, true, 'reached → true in the payload');
  assert.equal('connectorRoute' in body, false);
  const { clientAgentReached: _r, ...rest } = body;
  assert.equal(JSON.stringify(rest), PINNED_NO_CLIENT_AGENT, 'clientAgentReached adds one key, nothing else changes');
}
{
  const body = JSON.parse(await sendCallEnd(callEndExtras(false, undefined)));
  assert.equal(body.clientAgentReached, false, 'unreachable → false (key present)');
}
{
  const body = JSON.parse(await sendCallEnd(callEndExtras(undefined, ROUTE_TOKEN)));
  assert.equal(body.connectorRoute, ROUTE_TOKEN, 'connectorRoute served → echoed unchanged');
  assert.equal('clientAgentReached' in body, false, 'connector without an attempt → no clientAgentReached');
  const { connectorRoute: _c, ...rest } = body;
  assert.equal(JSON.stringify(rest), PINNED_NO_CLIENT_AGENT, 'connectorRoute adds one key, nothing else changes');
}
{
  const body = JSON.parse(await sendCallEnd(callEndExtras(true, ROUTE_TOKEN)));
  assert.equal(body.clientAgentReached, true);
  assert.equal(body.connectorRoute, ROUTE_TOKEN);
}
{
  // Pure builder agrees with what was sent.
  const built = buildCallEndPayload({
    callId: 'mock-call-id',
    transcript: TRANSCRIPT,
    fromNumber: '+15550000001',
    toNumber: '+15550000002',
    channel: 'pstn',
    durationSeconds: 42.4,
    engine: ENGINE,
  });
  assert.equal(JSON.stringify(built), PINNED_NO_CLIENT_AGENT);
  assert.equal(redactForLog(built), built, 'no token → the payload is logged as is');
  assert.equal(redactForLog({ connectorRoute: ROUTE_TOKEN }).connectorRoute, '[redacted]');
}
{
  // Recovery dump (web down, 3 attempts ~5 s): the token is never printed.
  webStatus = 503;
  const start = logged.length;
  await runWithSession({ callId: 'mock-call-id' }, () =>
    postCallEnd(TRANSCRIPT, '+15550000001', '+15550000002', undefined, 'pstn', 42, ENGINE, callEndExtras(false, ROUTE_TOKEN)),
  );
  webStatus = 200;
  const dump = logged.slice(start).find((l) => l.includes('recovery'));
  assert.ok(dump, 'recovery dump printed');
  assert.match(dump!, /"connectorRoute":"\[redacted\]"/, 'token masked in the recovery dump');
  assert.match(dump!, /"clientAgentReached":false/);
}

// ── 6. the call-end log line ─────────────────────────────────────────────
assert.equal(clientAgentReachLogLine(true, ROUTE_TOKEN), '[client-agent] reached=true connector=yes');
assert.equal(clientAgentReachLogLine(false, undefined), '[client-agent] reached=false connector=no');

// ── 7. source guards: campaign results unchanged, agent.ts wiring ────────
{
  const postCall = readFileSync(new URL('../src/post-call.ts', import.meta.url), 'utf8');
  const campaign = postCall.slice(postCall.indexOf('export async function postCampaignResult'), postCall.indexOf('/** Optional call-end fields'));
  assert.doesNotMatch(campaign, /clientAgentReached|connectorRoute/, 'campaign-result payload untouched');
  const agent = readFileSync(new URL('../agent.ts', import.meta.url), 'utf8');
  assert.match(agent, /callEndExtras\(reached, cfg\.connectorRoute\)/, 'agent.ts passes the extras to postCallEnd');
  assert.match(agent, /\.\.\.\(clientAgentLead \? \{ reach: clientAgentReach \} : \{\}\)/, 'only T5c lead is tracked, not tamaravox');
  assert.equal((agent.match(/reach: clientAgentReach,/g) ?? []).length, 2, 'voice turns and the opening are tracked');
}

server.close();

// ── 8. logs: no url, no secret, no connector token ───────────────────────
for (const line of logged) {
  assert.doesNotMatch(line, new RegExp(SECRET), `secret in log: ${line}`);
  assert.doesNotMatch(line, /tok-in-path|mock-query-token|agent\.example\.test/, `url in log: ${line}`);
  assert.doesNotMatch(line, /signed-token-v1/, `connector token in log: ${line}`);
}

console.log = orig.log;
console.warn = orig.warn;
console.error = orig.error;
say('ALL CLIENT-AGENT-REACH TESTS PASSED');
