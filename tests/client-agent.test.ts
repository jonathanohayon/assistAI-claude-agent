// tamaravox tool mode: ask_client_agent (src/client-agent.ts, tools/client-agent.ts,
// src/vox-brain.ts). Mock URLs, ids and business data only.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type https from 'node:https';
import { Readable } from 'node:stream';

import {
  CLIENT_AGENT_BUDGET_MS,
  CLIENT_AGENT_HISTORY_TURNS,
  askClientAgent,
  buildClientAgentRequest,
  isVoxToolCall,
  toolResultText,
} from '../src/client-agent.js';
import { createAgentPool, MAX_RESPONSE_BYTES } from '../src/net/agent-post.js';
import type { ResolvedAddress, Resolver } from '../src/net/safe-url.js';
import { voxBrainInstructions } from '../src/vox-brain.js';
import { makeClientAgentTools } from '../tools/client-agent.js';
import { depsWith, startServer } from './helpers/agent-test-server.js';

const hook = { url: 'https://agent.example.test/hook', secret: 'test-secret' };

// ── 1. aitamara calls are untouched: only a tamaravox config turns tool mode on
assert.equal(isVoxToolCall({}, {}), false, 'plain aitamara tenant');
assert.equal(isVoxToolCall({ agentWebhook: hook }, {}), false, 'aitamara tenant with its own webhook keeps the legacy path');
assert.equal(isVoxToolCall({ voxAgentId: 'agent-1' }, {}), false, 'no webhook, no tool');
assert.equal(isVoxToolCall({ voxAgentId: 'agent-1', agentWebhook: hook }, {}), true);
assert.equal(isVoxToolCall({ voxAgentId: 'agent-1', agentWebhook: hook }, { VOX_VERBATIM: '1' }), false, 'rollback switch');
{
  // the default config (no tamaravox, no web) is not a tool call and keeps its prompt
  const saved = { ...process.env };
  delete process.env['TAMARAVOX_URL'];
  delete process.env['APP_URL'];
  const { fetchConfig } = await import('../src/config-fetcher.js');
  const origLog = console.warn;
  console.warn = () => {};
  const cfg = await fetchConfig({ kind: 'sip', calledNumber: '+97220000000' } as never);
  console.warn = origLog;
  assert.equal(isVoxToolCall(cfg as never, {}), false);
  assert.doesNotMatch(cfg.instructions, /ask_client_agent/);
  process.env = saved;
}

// ── 2. request contract
const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? ('agent' as const) : ('user' as const), text: `t${i}` }));
const req = buildClientAgentRequest({
  callId: 'f39f8112641da664',
  turnId: 3,
  language: 'fr',
  question: ' Est-ce que la commande 0000 est prête ? ',
  callerSaid: "euh… c'est pour ma commande, la 0000",
  history,
});
assert.equal(req.call_id, 'f39f8112641da664');
assert.equal(req.question, 'Est-ce que la commande 0000 est prête ?');
assert.equal(req.history.length, CLIENT_AGENT_HISTORY_TURNS);
assert.equal(req.history[0]?.text, 't4');

// ── 3. webhook call, through the shared poster (src/net/agent-post.ts)
// Fake https.request. Like a real socket, it calls options.lookup (the
// poster's connect-time address guard) before connecting, and only "sends"
// the body once the lookup has succeeded.
interface Sent { connectedTo: string; headers: Record<string, string>; body: string }
const sent: Sent[] = [];
let reply: { status: number; body: string | Buffer } = { status: 200, body: '{}' };
const fakeRequest = ((options: https.RequestOptions, onResponse: (res: Readable & { statusCode?: number }) => void) => {
  const r = new EventEmitter() as EventEmitter & { end: (b: string) => void; destroy: () => void };
  r.destroy = () => {};
  r.end = (body: string) => {
    const lookup = options.lookup as unknown as (
      h: string, o: { all: boolean }, cb: (err: Error | null, a: ResolvedAddress[]) => void,
    ) => void;
    lookup(String(options.hostname), { all: true }, (err, addresses) => {
      if (err) { r.emit('error', err); return; }
      sent.push({ connectedTo: addresses[0]!.address, headers: options.headers as Record<string, string>, body });
      const res = Readable.from([Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body)]) as Readable & { statusCode?: number };
      res.statusCode = reply.status;
      onResponse(res);
    });
  };
  return r;
}) as unknown as typeof https.request;
const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const fakeDeps = (resolve: Resolver = async () => [PUBLIC]) => ({ deps: { resolve, request: fakeRequest } });
const answerWith = async (status: number, body: string | Buffer) => {
  reply = { status, body };
  return askClientAgent(hook, req, fakeDeps());
};

{
  // answer, signed over the exact body, contract keys only
  const ok = await answerWith(200, JSON.stringify({ answer: 'Prête, retrait dès 14 h, 12,50 €.' }));
  assert.equal(ok.answer, 'Prête, retrait dès 14 h, 12,50 €.');
  assert.equal(ok.failure, undefined);
  assert.equal(ok.status, 200);
  const seen = sent.at(-1)!;
  assert.equal(seen.connectedTo, PUBLIC.address, 'socket connects to the checked address');
  assert.equal(
    seen.headers['X-Tamara-Signature'],
    createHmac('sha256', 'test-secret').update(seen.body).digest('hex'),
    'HMAC over the exact body',
  );
  assert.equal(seen.body, JSON.stringify(req));
  assert.deepEqual(Object.keys(JSON.parse(seen.body)).sort(), ['call_id', 'caller_said', 'history', 'language', 'question', 'turn_id']);
}
assert.equal((await answerWith(200, '{"reply":"legacy"}')).answer, 'legacy', 'legacy reply field still accepted');
assert.equal((await answerWith(200, '{"answer":"new","reply":"legacy"}')).answer, 'new', 'answer wins over reply');
{
  const r = await answerWith(500, '{}');
  assert.equal(r.failure, 'http');
  assert.equal(r.status, 500);
}
assert.equal((await answerWith(302, '{"answer":"x"}')).failure, 'http', 'redirects are not followed');
assert.equal((await answerWith(200, 'not json')).failure, 'shape');
assert.equal((await answerWith(200, '{"answer":""}')).failure, 'shape');
{
  // response size limit: a body over MAX_RESPONSE_BYTES is a shape failure
  const huge = Buffer.from(JSON.stringify({ answer: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }));
  assert.equal((await answerWith(200, huge)).failure, 'shape');
}
{
  // unsigned without a secret
  reply = { status: 200, body: '{"answer":"ok"}' };
  await askClientAgent({ url: hook.url }, req, fakeDeps());
  assert.equal(sent.at(-1)!.headers['X-Tamara-Signature'], undefined);
}

// ── 3b. unsafe address: refused, no request sent, Tamara says she can't check
{
  const quiet = console.log;
  console.log = () => {};
  const before = sent.length;
  const priv = await askClientAgent(hook, req, fakeDeps(async () => [{ address: '10.0.0.5', family: 4 }]));
  const meta = await askClientAgent(hook, req, fakeDeps(async () => [{ address: '169.254.169.254', family: 4 }]));
  const literal = await askClientAgent({ ...hook, url: 'https://192.168.1.10/hook' }, req, fakeDeps());
  const plain = await askClientAgent({ ...hook, url: 'http://agent.example.test/hook' }, req, fakeDeps());
  const noDns = await askClientAgent(hook, req, fakeDeps(async () => { throw new Error('ENOTFOUND'); }));
  console.log = quiet;
  assert.equal(sent.length, before, 'no request sent to a refused address');
  for (const r of [priv, meta, literal, plain]) {
    assert.equal(r.answer, null);
    assert.equal(r.failure, 'unsafe_url');
    assert.match(toolResultText(r), /can't check this right now/);
    assert.doesNotMatch(toolResultText(r), /answered/);
  }
  assert.equal(noDns.failure, 'network', 'a host that does not resolve is a network failure');
}

// ── 3c. real node:https against a local TLS server (shared test helpers)
{
  const url = (port: number) => `https://agent.example.com:${port}/hook`;
  const quiet = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  // a stale reused keep-alive socket: exactly one retry on a fresh connection, then the answer
  {
    const server = await startServer('ok');
    const used = new Set<number>();
    server.override = ({ socketId }, res, sock) => {
      // Like a proxy that dropped the idle flow: a reused socket dies unanswered.
      if (used.has(socketId)) { sock.destroy(); return true; }
      used.add(socketId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ answer: 'Prête, retrait dès 14 h.' }));
      return true;
    };
    const pool = createAgentPool();
    const first = await askClientAgent({ ...hook, url: url(server.port) }, req, { deps: depsWith(pool) });
    assert.equal(first.answer, 'Prête, retrait dès 14 h.');
    await new Promise((r) => setTimeout(r, 500));
    const second = await askClientAgent({ ...hook, url: url(server.port) }, req, { deps: depsWith(pool) });
    assert.equal(second.answer, 'Prête, retrait dès 14 h.');
    assert.equal(second.failure, undefined);
    assert.equal(logs.filter((l) => l.startsWith('[agent_post] retry on fresh connection')).length, 1, 'exactly one retry');
    assert.equal(server.seen.length, 3, 'first, failed reuse, retry');
    assert.equal(server.seen[1]!.socketId, server.seen[0]!.socketId, 'the failed attempt reused the socket');
    assert.notEqual(server.seen[2]!.socketId, server.seen[1]!.socketId, 'the retry used a fresh connection');
    const expected = createHmac('sha256', 'test-secret').update(JSON.stringify(req)).digest('hex');
    for (const s of server.seen) {
      assert.equal(s.headers['x-tamara-signature'], expected, 'signature correct on every attempt, retry included');
      assert.equal(s.body, JSON.stringify(req));
    }
    pool.destroy();
    await server.close();
  }

  // a client agent that never answers: timeout at the 2.5 s budget, not later
  {
    const server = await startServer('ok');
    server.override = () => true; // never answers
    const pool = createAgentPool();
    const started = Date.now();
    const r = await askClientAgent({ ...hook, url: url(server.port) }, req, { deps: depsWith(pool) });
    const elapsed = Date.now() - started;
    assert.equal(CLIENT_AGENT_BUDGET_MS, 2500);
    assert.equal(r.failure, 'timeout');
    assert.equal(r.answer, null);
    assert.ok(elapsed >= CLIENT_AGENT_BUDGET_MS - 20 && elapsed < CLIENT_AGENT_BUDGET_MS + 400, `deadline is the budget (${elapsed}ms)`);
    assert.match(toolResultText(r), /can't check this right now/);
    pool.destroy();
    await server.close();
  }
  console.log = quiet;
}

// ── 4. tool result: facts verbatim, failure → take a message
const text = toolResultText({ answer: 'Prête, retrait dès 14 h, 12,50 €.', elapsedMs: 1 });
assert.ok(text.includes('Prête, retrait dès 14 h, 12,50 €.'), 'answer passed unchanged');
assert.match(text, /EXACTLY.*prices, dates, times, numbers, names, quantities and any yes\/no/);
assert.match(toolResultText({ answer: null, elapsedMs: 1, failure: 'timeout' }), /take a message/);

// ── 5. the tool: stall after 700 ms only when slow, cancelled on answer, one report per call
{
  const events: string[] = [];
  const reports: unknown[] = [];
  const mk = (delayMs: number) =>
    makeClientAgentTools({
      webhook: hook,
      getCallId: () => 'f39f8112641da664',
      getLanguage: () => 'fr',
      getCallerSaid: () => 'raw caller words',
      getHistory: () => [],
      startStall: () => {
        events.push('stall');
        return () => events.push('cancel');
      },
      onResult: (r) => reports.push(r),
      ask: async (_h, r) => {
        assert.equal(r.caller_said, 'raw caller words');
        await new Promise((res) => setTimeout(res, delayMs));
        return { answer: 'Oui.', elapsedMs: delayMs };
      },
    }).ask_client_agent;
  const log = console.log;
  console.log = () => {};
  const fast = await (mk(10) as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute({ question: 'q' }, {});
  assert.match(fast, /«Oui\.»/);
  assert.deepEqual(events, [], 'no holding line for a fast answer');
  await (mk(800) as unknown as { execute: (a: unknown, o: unknown) => Promise<string> }).execute({ question: 'q' }, {});
  console.log = log;
  assert.deepEqual(events, ['stall', 'cancel']);
  assert.equal(reports.length, 2, 'one /api/v1/turns report per tool call');
}

// ── 6. instructions: Tamara is the brain, business facts only via the tool
const ins = voxBrainInstructions({ name: 'Mock Bot', primaryLanguage: 'fr', languages: ['fr', 'en'], deliveryStyle: '' });
assert.match(ins, /You are Mock Bot/);
assert.match(ins, /call the tool ask_client_agent/);
assert.match(ins, /NOTHING spoken in the same turn/);
assert.match(ins, /Never guess, never invent/);

console.log('ALL CLIENT-AGENT TESTS PASSED');
