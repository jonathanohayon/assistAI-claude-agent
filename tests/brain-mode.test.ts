// T5c: the worker reads clientAgent (src/brain-mode.ts, src/config-fetcher.ts,
// tools/client-agent.ts). Mock urls, secrets, ids and business data only; every
// HTTP call goes to a local fake server on 127.0.0.1.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import {
  CLIENT_AGENT_VOICE_BUDGET_MS,
  apologyLine,
  clientAgentField,
  clientAgentOpening,
  createVoiceTurnQueue,
  parseClientAgent,
  runClientAgentVoiceTurn,
  selectBrainPlan,
  urlHost,
} from '../src/brain-mode.js';
import { stallLine } from '../src/agent-webhook.js';
import { askClientAgent, isVoxToolCall } from '../src/client-agent.js';
import { createAgentPool } from '../src/net/agent-post.js';
import { callIdFromRoomName } from '../src/session-context.js';
import { DEFAULT_VOICE_PROFILE, mapOpenAI } from '../src/voice-profile.js';
import { makeClientAgentTools } from '../tools/client-agent.js';
import { depsWith, loopbackRequest, startServer } from './helpers/agent-test-server.js';

const SECRET = 'mock-secret-do-not-log';
const ROOM = 'call-_+972500000000_mockroom';
const CALL_ID = callIdFromRoomName(ROOM);
const WEB_CONTRACT_KEYS = ['call_id', 'caller_said', 'history', 'language', 'question', 'turn_id'];

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

// ── Fake customer agent (HTTPS, through the real poster) + fake web (HTTP).
type Seen = { path: string; headers: IncomingMessage['headers']; body: string };
const seen: Seen[] = [];
let agentReply: (req: Seen, res: ServerResponse) => void = (_r, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ answer: 'Open 9 to 18, 12.50 EUR.' }));
};
let webPayload: Record<string, unknown> = {};
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = req.url ?? '';
    if (path.startsWith('/api/agent/config')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(webPayload));
      return;
    }
    res.writeHead(200);
    res.end('{}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

// The customer's agent: a local TLS server (test-only self-signed cert).
// Requests reach it through the real poster (src/net/agent-post.ts), with a
// loopback lookup in place of DNS.
const tls = {
  key: readFileSync(new URL('./fixtures/test-only-self-signed.key', import.meta.url)),
  cert: readFileSync(new URL('./fixtures/test-only-self-signed.crt', import.meta.url)),
};
const agentServer = https.createServer(tls, (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const s = { path: req.url ?? '', headers: req.headers, body };
    seen.push(s);
    agentReply(s, res);
  });
});
await new Promise<void>((r) => agentServer.listen(0, '127.0.0.1', r));
const agentPort = (agentServer.address() as AddressInfo).port;
const AGENT_URL = 'https://agent.example.test/hook/tok-in-path?k=mock-query-token';
const agentPool = createAgentPool();
const toLocal = (u: string) => u.replace('https://agent.example.test/', `https://agent.example.test:${agentPort}/`);
const ask: typeof askClientAgent = (w, r, o = {}) =>
  askClientAgent({ ...w, url: toLocal(w.url) }, r, { ...o, deps: { request: loopbackRequest, agent: agentPool } });

// ── 1. config parse ────────────────────────────────────────────────────
{
  const ok = parseClientAgent({ url: AGENT_URL, secret: SECRET, mode: 'lead', extra: 1 });
  assert.deepEqual(ok, { ok: true, value: { url: AGENT_URL, secret: SECRET, mode: 'lead' } }, 'unknown keys dropped');
  assert.deepEqual(parseClientAgent({ url: AGENT_URL, mode: 'voice' }), { ok: true, value: { url: AGENT_URL, mode: 'voice' } });
  assert.deepEqual(parseClientAgent({ url: AGENT_URL, secret: '', mode: 'voice' }), { ok: true, value: { url: AGENT_URL, mode: 'voice' } }, 'empty secret = unsigned');
  const bad: Array<[unknown, string]> = [
    [null, 'not_object'],
    ['https://x.test', 'not_object'],
    [[], 'not_object'],
    [{ mode: 'lead' }, 'bad_url'],
    [{ url: '', mode: 'lead' }, 'bad_url'],
    [{ url: 'not a url', mode: 'lead' }, 'bad_url'],
    [{ url: 'http://agent.example.test/hook', mode: 'lead' }, 'not_https'],
    [{ url: 'ftp://agent.example.test/hook', mode: 'lead' }, 'not_https'],
    [{ url: 'https://user:pw@agent.example.test/hook', mode: 'lead' }, 'bad_url'],
    [{ url: `https://agent.example.test/${'a'.repeat(2100)}`, mode: 'lead' }, 'bad_url'],
    [{ url: AGENT_URL, secret: 42, mode: 'lead' }, 'bad_secret'],
    [{ url: AGENT_URL }, 'bad_mode'],
    [{ url: AGENT_URL, mode: 'LEAD' }, 'bad_mode'],
    [{ url: AGENT_URL, mode: 'auto' }, 'bad_mode'],
  ];
  for (const [raw, reason] of bad) assert.deepEqual(parseClientAgent(raw), { ok: false, reason }, JSON.stringify(raw)?.slice(0, 80));

  const lines: string[] = [];
  assert.deepEqual(clientAgentField(undefined, (l) => lines.push(l)), {}, 'absent → no key');
  assert.deepEqual(lines, [], 'absent → silent');
  assert.deepEqual(clientAgentField({ url: 'http://agent.example.test/tok', secret: SECRET, mode: 'lead' }, (l) => lines.push(l)), {});
  assert.deepEqual(lines, ['[client_agent] config ignored: not_https'], 'invalid → one reason line, no url, no secret');
  assert.equal(urlHost(AGENT_URL), 'agent.example.test');
  assert.equal(urlHost('garbage'), '?');

  // Through fetchConfig against the fake web.
  process.env['APP_URL'] = BASE;
  process.env['INTERNAL_SECRET'] = 'mock-internal';
  const { fetchConfig } = await import('../src/config-fetcher.js');
  const origin = { kind: 'web', userId: 'mock-user-1' } as never;
  const base = { instructions: 'Mock persona', greetingInstructions: '', agentName: 'Mock', voice: 'marin', features: { calendar: false } };
  webPayload = base;
  const absent = await fetchConfig(origin);
  assert.equal('clientAgent' in absent, false, 'absent in payload → absent in config');
  webPayload = { ...base, clientAgent: { url: AGENT_URL, secret: SECRET, mode: 'voice' } };
  const present = await fetchConfig(origin);
  assert.deepEqual(present.clientAgent, { url: AGENT_URL, secret: SECRET, mode: 'voice' });
  const { clientAgent: _drop, ...rest } = present;
  assert.deepEqual(rest, absent, 'clientAgent adds one key, nothing else changes');
  webPayload = { ...base, clientAgent: { url: AGENT_URL, mode: 'something' } };
  assert.deepEqual(await fetchConfig(origin), absent, 'invalid → exactly the absent config');
}

// ── 2. mode selection + precedence ───────────────────────────────────────
{
  const legacy = { url: 'https://legacy.example.test/hook', secret: 'legacy-secret' };
  const lead = { url: AGENT_URL, secret: SECRET, mode: 'lead' as const };
  const voice = { url: AGENT_URL, mode: 'voice' as const };
  const e = {};
  // no clientAgent: exactly the previous selection
  assert.deepEqual(selectBrainPlan({}, e), { plan: { kind: 'own' }, overridesLegacyWebhook: false });
  const leg = selectBrainPlan({ agentWebhook: legacy }, e);
  assert.equal(leg.plan.kind, 'verbatim');
  assert.equal(leg.plan.kind === 'verbatim' && leg.plan.contract, 'legacy');
  assert.equal(leg.plan.kind === 'verbatim' && leg.plan.endpoint, legacy, 'legacy endpoint passed as the same object');
  assert.equal(leg.overridesLegacyWebhook, false);
  // clientAgent lead / voice
  assert.deepEqual(selectBrainPlan({ clientAgent: lead }, e), {
    plan: { kind: 'tool', source: 'client_agent', endpoint: { url: AGENT_URL, secret: SECRET } },
    overridesLegacyWebhook: false,
  });
  assert.deepEqual(selectBrainPlan({ clientAgent: voice }, e), {
    plan: { kind: 'verbatim', contract: 'client_agent', endpoint: { url: AGENT_URL } },
    overridesLegacyWebhook: false,
  });
  // clientAgent wins over the legacy webhook, and says so
  const both = selectBrainPlan({ clientAgent: lead, agentWebhook: legacy }, e);
  assert.equal(both.plan.kind === 'tool' && both.plan.endpoint.url, AGENT_URL);
  assert.equal(both.overridesLegacyWebhook, true);
  const bothV = selectBrainPlan({ clientAgent: voice, agentWebhook: legacy }, e);
  assert.equal(bothV.plan.kind === 'verbatim' && bothV.plan.contract, 'client_agent');
  assert.equal(bothV.overridesLegacyWebhook, true);
  // tamaravox keeps #31's behaviour, clientAgent never applies
  const vox = { voxAgentId: 'agent-1', agentWebhook: legacy, clientAgent: voice };
  assert.deepEqual(selectBrainPlan(vox, e), { plan: { kind: 'tool', source: 'vox', endpoint: legacy }, overridesLegacyWebhook: false });
  assert.equal(isVoxToolCall(vox, e), true);
  const voxV = selectBrainPlan(vox, { VOX_VERBATIM: '1' });
  assert.equal(voxV.plan.kind === 'verbatim' && voxV.plan.contract, 'legacy', 'VOX_VERBATIM rollback unchanged');
  assert.deepEqual(selectBrainPlan({ voxAgentId: 'agent-1', clientAgent: lead }, e), { plan: { kind: 'own' }, overridesLegacyWebhook: false });

  // "voice" (and legacy) = verbatim = create_response off; "lead" keeps it on.
  const ctx = (webhookMode: boolean) => ({ model: 'gpt-realtime-2', speed: 1, primaryLanguage: 'en', webhookMode });
  const td = (p: ReturnType<typeof selectBrainPlan>['plan']) =>
    mapOpenAI(DEFAULT_VOICE_PROFILE, ctx(p.kind === 'verbatim')).turnDetection['create_response'];
  assert.equal(td(selectBrainPlan({ clientAgent: voice }, e).plan), false, 'voice → create_response off');
  assert.equal(td(selectBrainPlan({ clientAgent: lead }, e).plan), true, 'lead → create_response on');
  assert.equal(td(selectBrainPlan({}, e).plan), true, 'own brain unchanged');
}

// ── 3. "lead": the tool, pointed at clientAgent.url, web contract, signature ─
{
  const sel = selectBrainPlan({ clientAgent: { url: AGENT_URL, secret: SECRET, mode: 'lead' } }, {});
  assert.ok(sel.plan.kind === 'tool');
  seen.length = 0;
  const tool = makeClientAgentTools({
    webhook: sel.plan.endpoint,
    getCallId: () => CALL_ID,
    getLanguage: () => 'en',
    getCallerSaid: () => 'uh, when are you open on sunday',
    getHistory: () => [{ role: 'agent', text: 'Hello, Mock Salon.' }],
    ask,
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
  const out = await tool.execute({ question: 'What are the opening hours on Sunday?' }, {});
  assert.match(out, /«Open 9 to 18, 12\.50 EUR\.»/, 'the answer reaches the model unchanged');
  assert.equal(seen.length, 1);
  const s = seen[0]!;
  assert.equal(s.path, '/hook/tok-in-path?k=mock-query-token', 'posted to clientAgent.url');
  const body = JSON.parse(s.body);
  assert.deepEqual(Object.keys(body).sort(), WEB_CONTRACT_KEYS, 'exactly the web contract');
  assert.deepEqual(body, {
    call_id: CALL_ID,
    turn_id: 1,
    language: 'en',
    question: 'What are the opening hours on Sunday?',
    caller_said: 'uh, when are you open on sunday',
    history: [{ role: 'agent', text: 'Hello, Mock Salon.' }],
  });
  assert.equal(s.headers['x-tamara-signature'], createHmac('sha256', SECRET).update(s.body).digest('hex'), 'HMAC-SHA256 hex of the raw body');
  assert.equal(s.headers['content-type'], 'application/json');
  assert.doesNotMatch(s.body, /972500000000|mockroom/, 'no room name sent');

  // legacy `reply` accepted
  agentReply = (_r, res) => {
    res.writeHead(200);
    res.end('{"reply":"Legacy answer."}');
  };
  assert.match(await tool.execute({ question: 'q' }, {}), /«Legacy answer\.»/);

  // ── lead failures → the model is told to say it can't check (never silence)
  const failing: Array<[string, (r: Seen, res: ServerResponse) => void]> = [
    ['http', (_r, res) => { res.writeHead(500); res.end('{}'); }],
    ['shape', (_r, res) => { res.writeHead(200); res.end('not json'); }],
    ['empty', (_r, res) => { res.writeHead(200); res.end('{"answer":"  "}'); }],
  ];
  for (const [name, h] of failing) {
    agentReply = h;
    assert.match(await tool.execute({ question: 'q' }, {}), /did not answer.*can't check this right now/s, `lead ${name}`);
  }
  // timeout (short budget) and network (closed port)
  const slow = makeClientAgentTools({
    webhook: sel.plan.endpoint,
    getCallId: () => CALL_ID,
    getLanguage: () => 'en',
    getCallerSaid: () => '',
    getHistory: () => [],
    ask: (w, r) => ask(w, r, { budgetMs: 50 }),
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
  agentReply = (_r, res) => setTimeout(() => { res.writeHead(200); res.end('{"answer":"late"}'); }, 300);
  assert.match(await slow.execute({ question: 'q' }, {}), /did not answer/, 'lead timeout');
  const dead = makeClientAgentTools({
    webhook: { url: 'https://127.0.0.1:1/hook', secret: SECRET },
    getCallId: () => CALL_ID,
    getLanguage: () => 'en',
    getCallerSaid: () => '',
    getHistory: () => [],
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
  assert.match(await dead.execute({ question: 'q' }, {}), /did not answer/, 'lead network');
  // a throwing dependency never escapes the tool
  const throwing = makeClientAgentTools({
    webhook: sel.plan.endpoint,
    getCallId: () => { throw new Error(`boom ${ROOM} ${SECRET}`); },
    getLanguage: () => 'en',
    getCallerSaid: () => '',
    getHistory: () => [],
    ask,
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
  assert.match(await throwing.execute({ question: 'q' }, {}), /did not answer/, 'lead throw');
}

// ── 4. "voice": verbatim, answer spoken, opening line ─────────────────────
{
  const sel = selectBrainPlan({ clientAgent: { url: AGENT_URL, secret: SECRET, mode: 'voice' } }, {});
  assert.ok(sel.plan.kind === 'verbatim');
  const endpoint = sel.plan.endpoint;
  agentReply = (_r, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ answer: 'Your order 0000 is ready, 12.50 EUR.' }));
  };
  seen.length = 0;
  const spoken: string[] = [];
  const speak = async (t: string) => {
    spoken.push(t);
  };
  const outcome = await runClientAgentVoiceTurn({
    endpoint,
    callId: CALL_ID,
    turnId: 3,
    language: 'en',
    callerSaid: 'is my order 0000 ready',
    history: [{ role: 'user', text: 'hi' }],
    speak,
    ask,
  });
  assert.equal(outcome, 'answered');
  assert.deepEqual(spoken, ['Your order 0000 is ready, 12.50 EUR.'], 'the answer, verbatim, and nothing else');
  const body = JSON.parse(seen[0]!.body);
  assert.deepEqual(Object.keys(body).sort(), WEB_CONTRACT_KEYS);
  assert.equal(body.question, 'is my order 0000 ready');
  assert.equal(body.caller_said, 'is my order 0000 ready');
  assert.equal(body.call_id, CALL_ID);
  assert.equal(seen[0]!.headers['x-tamara-signature'], createHmac('sha256', SECRET).update(seen[0]!.body).digest('hex'));

  // opening line: turn 0, empty question, as the web's test request
  seen.length = 0;
  agentReply = (_r, res) => {
    res.writeHead(200);
    res.end('{"answer":"Hello, Mock Shop, how can I help?"}');
  };
  assert.equal(await clientAgentOpening({ endpoint, callId: CALL_ID, language: 'en', ask }), 'Hello, Mock Shop, how can I help?');
  assert.deepEqual(JSON.parse(seen[0]!.body), { call_id: CALL_ID, turn_id: 0, language: 'en', question: '', caller_said: '', history: [] });
  agentReply = (_r, res) => { res.writeHead(503); res.end(''); };
  assert.equal(await clientAgentOpening({ endpoint, callId: CALL_ID, language: 'en', ask }), null, 'no answer → model greeting');
  assert.equal(await clientAgentOpening({ endpoint, callId: CALL_ID, language: 'en', ask: async () => { throw new Error('x'); } }), null);

  // ── voice failures → a holding / apology line, never silence, never a throw
  const run = async (o: Partial<Parameters<typeof runClientAgentVoiceTurn>[0]>) => {
    const said: string[] = [];
    const r = await runClientAgentVoiceTurn({
      endpoint,
      callId: CALL_ID,
      turnId: 9,
      language: 'en',
      callerSaid: 'q',
      history: [],
      speak: async (t) => { said.push(t); },
      ask,
      ...o,
    });
    return { r, said };
  };
  agentReply = (_r, res) => { res.writeHead(500); res.end('{}'); };
  assert.deepEqual(await run({}), { r: 'http', said: [apologyLine('en')] });
  agentReply = (_r, res) => { res.writeHead(200); res.end('{"nope":1}'); };
  assert.deepEqual(await run({}), { r: 'shape', said: [apologyLine('en')] });
  agentReply = (_r, res) => setTimeout(() => { res.writeHead(200); res.end('{"answer":"late"}'); }, 400);
  assert.deepEqual(
    await run({ ask: (w, r) => ask(w, r, { budgetMs: 150 }), stallMs: 30 }),
    { r: 'timeout', said: [stallLine('en'), apologyLine('en')] },
    'slow: holding line, then apology',
  );
  // unsafe url (IP literal, or a host resolving to a private address): no
  // request sent, the apology line is said
  {
    const before = seen.length;
    assert.deepEqual(await run({ endpoint: { url: 'https://127.0.0.1:1/hook' }, ask: askClientAgent }), { r: 'unsafe_url', said: [apologyLine('en')] });
    const privatePool = createAgentPool();
    const privateAsk: typeof askClientAgent = (w, r, o = {}) =>
      askClientAgent(w, r, { ...o, deps: { resolve: async () => [{ address: '10.0.0.5', family: 4 }], agent: privatePool } });
    assert.deepEqual(await run({ ask: privateAsk }), { r: 'unsafe_url', said: [apologyLine('en')] });
    assert.equal(seen.length, before, 'no request sent to an unsafe url');
    privatePool.destroy();
  }
  assert.deepEqual(await run({ ask: async () => { throw new Error(`boom ${SECRET}`); } }), { r: 'error', said: [apologyLine('en')] });
  // speak itself failing: still resolves (the turn loop never sees a throw)
  let tries = 0;
  const r = await runClientAgentVoiceTurn({
    endpoint, callId: CALL_ID, turnId: 10, language: 'he', callerSaid: 'q', history: [], ask,
    speak: async () => { tries += 1; throw new Error('tts down'); },
  });
  assert.equal(r, 'error');
  assert.equal(tries, 2, 'answer attempt, then the apology attempt');
  assert.match(apologyLine('he'), /[֐-׿]/);
  assert.match(apologyLine('fr'), /Désolée/);
  assert.equal(apologyLine('xx'), apologyLine('en'));
}

// ── 4b. "voice" through the poster: one retry on a stale reused socket, 2 s budget
{
  assert.equal(CLIENT_AGENT_VOICE_BUDGET_MS, 2000, 'voice turns: the legacy verbatim 2 s budget');
  const budgets: Array<number | undefined> = [];
  const spy: typeof askClientAgent = (w, r, o = {}) => {
    budgets.push(o.budgetMs);
    return ask(w, r, o);
  };
  await runClientAgentVoiceTurn({
    endpoint: { url: AGENT_URL }, callId: CALL_ID, turnId: 1, language: 'en', callerSaid: 'q', history: [],
    speak: async () => {}, ask: spy,
  });
  await clientAgentOpening({ endpoint: { url: AGENT_URL }, callId: CALL_ID, language: 'en', ask: spy });
  assert.deepEqual(budgets, [2000, 2000], 'turn and opening both pass the voice budget');

  const stale = await startServer('ok');
  const used = new Set<number>();
  stale.override = ({ socketId }, res, sock) => {
    // Like a proxy that dropped the idle flow: a reused socket dies unanswered.
    if (used.has(socketId)) { sock.destroy(); return true; }
    used.add(socketId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answer: 'Mock answer.' }));
    return true;
  };
  const pool = createAgentPool();
  const staleAsk: typeof askClientAgent = (w, r, o = {}) =>
    askClientAgent({ ...w, url: `https://agent.example.com:${stale.port}/hook` }, r, { ...o, deps: depsWith(pool) });
  const said: string[] = [];
  const turn = (turnId: number) =>
    runClientAgentVoiceTurn({
      endpoint: { url: AGENT_URL }, callId: CALL_ID, turnId, language: 'en', callerSaid: 'q', history: [],
      speak: async (t) => { said.push(t); }, ask: staleAsk,
    });
  assert.equal(await turn(1), 'answered');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await turn(2), 'answered', 'the stale socket is retried, the caller gets the answer');
  assert.deepEqual(said, ['Mock answer.', 'Mock answer.']);
  assert.equal(stale.seen.length, 3, 'first, failed reuse, one retry');
  assert.equal(stale.seen[1]!.socketId, stale.seen[0]!.socketId, 'the failed attempt reused the socket');
  assert.notEqual(stale.seen[2]!.socketId, stale.seen[1]!.socketId, 'the retry used a fresh connection');
  assert.ok(logged.filter((l) => l.startsWith('[agent_post] retry on fresh connection')).length >= 1);
  pool.destroy();
  await stale.close();
}

// ── 4c. "voice": a turn said while a request is in flight is sent after, not
// dropped; the in-flight turn's reply, now stale, is not spoken
{
  const timeline: string[] = [];
  let open = 0;
  let maxOpen = 0;
  agentReply = (req, res) => {
    open += 1;
    maxOpen = Math.max(maxOpen, open);
    const body = JSON.parse(req.body) as { turn_id: number; caller_said: string };
    timeline.push(`request ${body.turn_id}`);
    setTimeout(() => {
      open -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answer: `Answer ${body.turn_id}.` }));
    }, 300);
  };
  seen.length = 0;
  const transcriptMock: Array<{ role: 'user' | 'agent'; text: string }> = [];
  const doneTurns: number[] = [];
  const queueLogs: string[] = [];
  const queue = createVoiceTurnQueue(async (callerSaid, turnId, turn) => {
    await runClientAgentVoiceTurn({
      endpoint: { url: AGENT_URL, secret: SECRET }, callId: CALL_ID, turnId, language: 'fr', callerSaid,
      history: [...transcriptMock], ask, stallMs: 5000, isStale: turn.isStale,
      speak: async (t) => {
        timeline.push(`spoken ${t}`);
        transcriptMock.push({ role: 'agent', text: t });
      },
    });
    doneTurns.push(turnId);
  }, (l) => queueLogs.push(l));

  transcriptMock.push({ role: 'user', text: 'Bonjour, une question.' });
  assert.equal(queue.submit('Bonjour, une question.'), 'sent');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(queue.inFlight, true, 'turn 1 is in flight');
  transcriptMock.push({ role: 'user', text: 'Au revoir.' });
  assert.equal(queue.submit('Au revoir.'), 'queued', 'not dropped while turn 1 is in flight');
  const until = Date.now() + 3000;
  while (doneTurns.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(doneTurns, [1, 2]);
  assert.deepEqual(timeline, ['request 1', 'request 2', 'spoken Answer 2.'], 'turn 2 is sent after turn 1; the stale Answer 1 is never spoken');
  assert.ok(logged.includes('[voice] turn 1 reply dropped (stale)'));
  assert.equal(maxOpen, 1, 'never two requests in flight');
  const second = JSON.parse(seen[1]!.body);
  assert.equal(second.turn_id, 2);
  assert.equal(second.caller_said, 'Au revoir.');
  assert.equal(second.question, 'Au revoir.');
  assert.deepEqual(second.history.map((h: { text: string }) => h.text), ['Bonjour, une question.', 'Au revoir.'], 'history read when sent: the earlier caller words are not lost');
  assert.equal(seen[1]!.headers['x-tamara-signature'], createHmac('sha256', SECRET).update(seen[1]!.body).digest('hex'));
  assert.equal(queue.inFlight, false);

  // several turns while in flight: the newest replaces the older pending one
  seen.length = 0;
  doneTurns.length = 0;
  assert.equal(queue.submit('first'), 'sent');
  assert.equal(queue.submit('second'), 'queued');
  assert.equal(queue.submit('third'), 'replaced');
  const until2 = Date.now() + 3000;
  while (doneTurns.length < 2 && Date.now() < until2) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(doneTurns, [3, 4], 'turn ids keep counting');
  assert.deepEqual(seen.map((x) => JSON.parse(x.body).caller_said), ['first', 'third'], 'the newest pending turn is sent');
  assert.equal(maxOpen, 1);

  // call end: the pending turn is dropped, nothing sent after
  seen.length = 0;
  doneTurns.length = 0;
  assert.equal(queue.submit('one'), 'sent');
  assert.equal(queue.submit('two'), 'queued');
  queue.stop();
  assert.equal(queue.submit('three'), 'stopped');
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(seen.length, 1, 'nothing sent after stop');

  // a run that throws never blocks the queue
  const q2: number[] = [];
  const throwing = createVoiceTurnQueue(async (_t, id) => {
    q2.push(id);
    if (id === 1) throw new Error('boom');
  }, () => {});
  throwing.submit('a');
  throwing.submit('b');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(q2, [1, 2]);
  assert.ok(queueLogs.every((l) => !/Bonjour|revoir|first|second|third/.test(l)), 'queue logs carry no caller words');
}

// ── 4d. "lead": the default tool path is the poster-based askClientAgent
{
  const before = seen.length;
  const tool = makeClientAgentTools({
    webhook: { url: 'https://10.0.0.5/hook' },
    getCallId: () => CALL_ID,
    getLanguage: () => 'en',
    getCallerSaid: () => '',
    getHistory: () => [],
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
  assert.match(await tool.execute({ question: 'q' }, {}), /did not answer/);
  assert.equal(seen.length, before, 'no request sent');
  assert.ok(logged.some((l) => l.includes('unsafe_url')), "refused by askClientAgent's url check (unsafe_url)");
}

server.close();
agentPool.destroy();
await new Promise<void>((r) => agentServer.close(() => r()));

// ── 5. logs: no secret, no full url, no room name, no caller words ────────
for (const line of logged) {
  assert.doesNotMatch(line, new RegExp(SECRET), `secret in log: ${line}`);
  assert.doesNotMatch(line, /tok-in-path|mock-query-token/, `url path/query in log: ${line}`);
  assert.doesNotMatch(line, /972500000000|mockroom/, `room name in log: ${line}`);
  assert.doesNotMatch(line, /order 0000|opening hours/i, `caller words in log: ${line}`);
}
assert.ok(logged.some((l) => l.includes('[client_agent] voice turn 3 → ok')), 'voice turn logged by id');
assert.ok(logged.some((l) => l.includes('[client_agent] turn 1 → ok')), 'lead tool call logged by id');

console.log = orig.log;
console.warn = orig.warn;
console.error = orig.error;
say('ALL BRAIN-MODE TESTS PASSED');
