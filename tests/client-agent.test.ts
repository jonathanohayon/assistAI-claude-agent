// tamaravox tool mode: ask_client_agent (src/client-agent.ts, tools/client-agent.ts,
// src/vox-brain.ts). Mock URLs, ids and business data only.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  CLIENT_AGENT_HISTORY_TURNS,
  askClientAgent,
  buildClientAgentRequest,
  isVoxToolCall,
  toolResultText,
} from '../src/client-agent.js';
import { voxBrainInstructions } from '../src/vox-brain.js';
import { makeClientAgentTools } from '../tools/client-agent.js';

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

// ── 3. webhook call (mocked fetch)
const respond = (status: number, body: string, delayMs = 0) =>
  (async (_u: string, init?: { signal?: AbortSignal }) => {
    if (delayMs) {
      await new Promise((r, rej) => {
        const t = setTimeout(r, delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    return new Response(body, { status });
  }) as unknown as typeof fetch;

let seen: { headers: Record<string, string>; body: string } | null = null;
const capture = (async (_u: string, init: { headers: Record<string, string>; body: string }) => {
  seen = { headers: init.headers, body: init.body };
  return new Response(JSON.stringify({ answer: 'Prête, retrait dès 14 h, 12,50 €.' }), { status: 200 });
}) as unknown as typeof fetch;
const ok = await askClientAgent(hook, req, { fetchImpl: capture });
assert.equal(ok.answer, 'Prête, retrait dès 14 h, 12,50 €.');
assert.equal(
  seen!.headers['X-Tamara-Signature'],
  createHmac('sha256', 'test-secret').update(seen!.body).digest('hex'),
  'HMAC over the exact body',
);
assert.deepEqual(Object.keys(JSON.parse(seen!.body)).sort(), ['call_id', 'caller_said', 'history', 'language', 'question', 'turn_id']);
assert.equal((await askClientAgent(hook, req, { fetchImpl: respond(200, '{"reply":"legacy"}') })).answer, 'legacy');
assert.equal((await askClientAgent(hook, req, { fetchImpl: respond(500, '{}') })).failure, 'http');
assert.equal((await askClientAgent(hook, req, { fetchImpl: respond(200, 'not json') })).failure, 'shape');
assert.equal((await askClientAgent(hook, req, { fetchImpl: respond(200, '{"answer":""}') })).failure, 'shape');
assert.equal((await askClientAgent(hook, req, { fetchImpl: respond(200, '{}', 200), budgetMs: 50 })).failure, 'timeout');

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
