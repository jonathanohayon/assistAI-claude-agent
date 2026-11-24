// T5c "lead": caller_said and history when the caller speaks over the
// greeting (barge-in). Events are replayed in the order the SDK emits them
// (@livekit/agents 1.9.5, OpenAI Realtime, server VAD, no local VAD):
//   input_audio_buffer.speech_started  → UserStateChanged listening→speaking
//   input_audio_buffer.speech_stopped  → UserStateChanged speaking→listening
//   (response.created → the model's tool call: can run before the transcript)
//   ...input_audio_transcription.delta → UserInputTranscribed isFinal:false
//   ...input_audio_transcription.completed → UserInputTranscribed isFinal:true
//                                          (+ ConversationItemAdded, user)
// Over the greeting the input is muted / silenced, so the caller's speech
// arrives as several short segments, each with its own speech_stopped and its
// own final transcript, the first one often empty (a clipped fragment).
// Mock data only, no network (fake `ask`).
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { CALLER_SAID_WAIT_MS, createCallerTurnTracker } from '../src/caller-turn.js';
import type { ClientAgentRequest, ClientAgentResult } from '../src/client-agent.js';
import { makeClientAgentTools, withCallerTurn } from '../tools/client-agent.js';

const ENDPOINT = { url: 'https://agent.example.com/hook', secret: 'mock-secret' };
const GREETING = 'Bonjour, Salon Mock, que puis-je faire pour vous ?';
const SAID = 'Je voudrais un rendez-vous demain matin.';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

mock.timers.enable({ apis: ['setTimeout', 'Date'] });
const log = console.log;
console.log = () => {};

/** A mock call: the worker's transcript + tracker, wired like agent.ts. */
function mockCall() {
  const transcript: Array<{ role: 'user' | 'agent'; text: string }> = [];
  const turns = createCallerTurnTracker();
  const seen: ClientAgentRequest[] = [];
  const tool = makeClientAgentTools({
    webhook: ENDPOINT,
    getCallId: () => 'mock-call',
    getLanguage: () => 'fr',
    getCallerSaid: () => turns.callerSaid(),
    getHistory: () => [...transcript],
    ask: (async (_e: unknown, req: ClientAgentRequest): Promise<ClientAgentResult> => {
      seen.push(req);
      return { answer: 'Réponse mock.', elapsedMs: 5 };
    }) as never,
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
  const ev = {
    /** UserStateChanged speaking→listening (speech_stopped). */
    speechStopped: () => turns.speechEnded(),
    interim: (text: string, itemId: string) => turns.interimTranscript(text, itemId),
    /** UserInputTranscribed final, then the transcript entry agent.ts pushes. */
    final: (text: string, itemId: string) => {
      turns.finalTranscript(text, itemId);
      if (text.trim()) transcript.push({ role: 'user', text: text.trim() });
    },
  };
  return { transcript, turns, seen, tool, ev };
}

// ── 1. Barge-in: an earlier segment's empty final no longer ends the wait ───
{
  const c = mockCall();
  c.transcript.push({ role: 'agent', text: GREETING });
  c.ev.speechStopped(); // segment 1: the clipped part right after the greeting
  c.ev.speechStopped(); // segment 2: the rest of the sentence
  const out = c.tool.execute({ question: 'Book tomorrow morning' }, {});
  await flush();
  c.ev.final('', 'item_seg1'); // the clipped fragment: transcribed as nothing
  await flush();
  assert.equal(c.seen.length, 0, 'still waiting for the segment that led to the tool call');
  c.ev.interim('Je voudrais un rendez-vous', 'item_seg2');
  c.ev.final(SAID, 'item_seg2');
  await out;
  assert.equal(c.seen[0]!.caller_said, SAID, 'caller_said = the words said over and after the greeting');
  assert.deepEqual(c.seen[0]!.history.map((h) => h.text), [GREETING, SAID], 'history includes them, once');
}

// ── 2. Barge-in, final later than the wait: the interim text is sent ────────
{
  const c = mockCall();
  c.transcript.push({ role: 'agent', text: GREETING });
  c.ev.speechStopped();
  c.ev.interim('Je voudrais un rendez-vous demain', 'item_a');
  const out = c.tool.execute({ question: 'Book tomorrow' }, {});
  await flush();
  assert.equal(c.seen.length, 0);
  mock.timers.tick(CALLER_SAID_WAIT_MS);
  await out;
  assert.equal(c.seen[0]!.caller_said, 'Je voudrais un rendez-vous demain', 'never "" when the caller spoke');
  assert.deepEqual(
    c.seen[0]!.history.map((h) => `${h.role}:${h.text}`),
    [`agent:${GREETING}`, 'user:Je voudrais un rendez-vous demain'],
    'the interim words close the history',
  );
  // The late final lands: the next call reads it, without waiting again.
  c.ev.final(SAID, 'item_a');
  const next = c.tool.execute({ question: 'q' }, {});
  await next;
  assert.equal(c.seen[1]!.caller_said, SAID);
  assert.deepEqual(c.seen[1]!.history.map((h) => h.text), [GREETING, SAID]);
}

// ── 3. An empty final keeps the interim words of the same item ──────────────
{
  const c = mockCall();
  c.ev.speechStopped();
  c.ev.interim('Bonjour je voudrais', 'item_b');
  c.ev.final('', 'item_b');
  const out = c.tool.execute({ question: 'q' }, {});
  await out;
  assert.equal(c.seen[0]!.caller_said, 'Bonjour je voudrais');
}

// ── 4. Normal order (transcript before the tool call) is unchanged ──────────
{
  const c = mockCall();
  c.transcript.push({ role: 'agent', text: GREETING });
  c.ev.speechStopped();
  c.ev.interim('Vous êtes', 'item_c');
  c.ev.final('Vous êtes ouverts quand ?', 'item_c');
  const out = c.tool.execute({ question: 'Opening hours?' }, {});
  await out;
  assert.equal(c.seen[0]!.caller_said, 'Vous êtes ouverts quand ?');
  assert.deepEqual(c.seen[0]!.history.map((h) => h.text), [GREETING, 'Vous êtes ouverts quand ?']);
  // An interim of an older item never beats a newer final.
  c.ev.speechStopped();
  c.ev.interim('fragment ancien', 'item_old');
  c.ev.speechStopped();
  c.ev.final('Et le samedi ?', 'item_d');
  c.ev.final('', 'item_old');
  await c.tool.execute({ question: 'Saturday?' }, {});
  assert.equal(c.seen[1]!.caller_said, 'Et le samedi ?');
}

// ── 5. No utterance at all: "" (nothing invented), no wait ──────────────────
{
  const c = mockCall();
  c.transcript.push({ role: 'agent', text: GREETING });
  await c.tool.execute({ question: 'q' }, {});
  assert.equal(c.seen[0]!.caller_said, '', 'nothing said → ""');
  assert.deepEqual(c.seen[0]!.history.map((h) => h.text), [GREETING], 'no invented user turn');
  assert.deepEqual(withCallerTurn([], ''), []);
}

// ── 6. The wait stays bounded, and is not paid twice ────────────────────────
{
  const turns = createCallerTurnTracker();
  turns.speechEnded();
  turns.speechEnded();
  const p = turns.callerSaidWithSource();
  let settled = false;
  void p.then(() => (settled = true));
  mock.timers.tick(CALLER_SAID_WAIT_MS - 1);
  await flush();
  assert.equal(settled, false);
  mock.timers.tick(1);
  const r = await p;
  assert.deepEqual([r.text, r.source, r.waitedMs], ['', 'none', CALLER_SAID_WAIT_MS], 'at most 1 s, then ""');
  assert.equal(turns.pending, false, 'given-up turns are not awaited by the next tool call');
  const again = await turns.callerSaidWithSource();
  assert.equal(again.waitedMs, 0);
  assert.equal(CALLER_SAID_WAIT_MS, 1000, 'the lead budget is 2.5 s in all');
}

console.log = log;
console.log('caller-turn-bargein: ok');
