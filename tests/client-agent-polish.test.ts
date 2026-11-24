// T5c polish, from a real signed test call: the "lead" body carries the call's
// language and the caller's words; the holding line only after 1.5 s and never
// on two consecutive turns; stale "voice" replies dropped; a turn finishing on
// a closed session ends quietly. Mock data only, no network (fake `ask`).
import assert from 'node:assert/strict';
import { mock } from 'node:test';

import { stallLine } from '../src/agent-webhook.js';
import { createVoiceTurnQueue, runClientAgentVoiceTurn, type VoiceTurnOutcome } from '../src/brain-mode.js';
import { callerLanguageOf, createCallerTurnTracker } from '../src/caller-turn.js';
import type { ClientAgentRequest, ClientAgentResult } from '../src/client-agent.js';
import { createClientAgentReachTracker } from '../src/client-agent-reach.js';
import { createStallGate, STALL_AFTER_MS } from '../src/stall-gate.js';
import { makeClientAgentTools } from '../tools/client-agent.js';

const ENDPOINT = { url: 'https://agent.example.com/hook', secret: 'mock-secret' };
const CALL_ID = 'f39f8112641da664';
const STALL_FR = stallLine('fr');

/** Lets pending promise callbacks run (setImmediate is not faked). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A fake customer agent answering after `delayMs` (on the faked clock). */
const askAfter = (delayMs: number, answer = 'Réponse.', seen: ClientAgentRequest[] = []) =>
  (async (_e: unknown, req: ClientAgentRequest): Promise<ClientAgentResult> => {
    seen.push(req);
    await new Promise((r) => setTimeout(r, delayMs));
    return { answer, elapsedMs: delayMs };
  }) as never;

mock.timers.enable({ apis: ['setTimeout'] });

// ── 1. "lead" body: the call's language and the caller's last words ─────────
{
  assert.equal(callerLanguageOf('Bonjour, vous êtes ouverts ?', 'fr'), 'fr', 'a French call → fr');
  assert.equal(callerLanguageOf('Bonjour, vous êtes ouverts ?', undefined), 'fr', 'no primary language → fr, never en');
  assert.equal(callerLanguageOf(undefined, undefined), 'fr');
  assert.equal(callerLanguageOf('שלום, אתם פתוחים?', 'fr'), 'he');
  assert.equal(callerLanguageOf('Hello', 'en'), 'en');

  // The real race: the model calls the tool before the transcript of the
  // turn that led to it has landed.
  const transcript: Array<{ role: 'user' | 'agent'; text: string }> = [];
  const turns = createCallerTurnTracker();
  const seen: ClientAgentRequest[] = [];
  const tool = makeClientAgentTools({
    webhook: ENDPOINT,
    getCallId: () => CALL_ID,
    getLanguage: () => callerLanguageOf([...transcript].reverse().find((t) => t.role === 'user')?.text, undefined),
    getCallerSaid: () => turns.callerSaid(),
    getHistory: () => [...transcript],
    ask: askAfter(100, 'Ouvert de 9 h à 18 h.', seen),
  }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };

  const log = console.log;
  console.log = () => {};
  transcript.push({ role: 'agent', text: 'Bonjour, Salon Mock.' });
  turns.speechEnded();
  const out = tool.execute({ question: 'What are your opening hours?' }, {});
  await flush();
  assert.equal(seen.length, 0, 'waits for the caller transcript before sending');
  turns.finalTranscript('Vous êtes ouverts quand ?');
  transcript.push({ role: 'user', text: 'Vous êtes ouverts quand ?' });
  await flush();
  mock.timers.tick(100);
  await out;
  assert.equal(seen[0]!.language, 'fr', 'a French call → "fr"');
  assert.equal(seen[0]!.caller_said, 'Vous êtes ouverts quand ?', 'caller_said = the last caller utterance');
  assert.deepEqual(seen[0]!.history.map((h) => h.text), ['Bonjour, Salon Mock.', 'Vous êtes ouverts quand ?']);

  // Transcript already in: no wait, the last caller utterance.
  const second = tool.execute({ question: 'q' }, {});
  await flush();
  mock.timers.tick(100);
  await second;
  assert.equal(seen[1]!.caller_said, 'Vous êtes ouverts quand ?');

  // A transcript that never comes: bounded wait, then the newest one known.
  turns.speechEnded();
  const third = tool.execute({ question: 'q' }, {});
  await flush();
  assert.equal(seen.length, 2);
  mock.timers.tick(1000);
  await flush();
  mock.timers.tick(100);
  await third;
  console.log = log;
  assert.equal(seen[2]!.caller_said, 'Vous êtes ouverts quand ?', 'bounded wait, never stuck');
  assert.equal(turns.pending, false, 'a turn given up on is not awaited again');
  turns.speechEnded();
  assert.equal(turns.pending, true);
  turns.finalTranscript('');
  assert.equal(turns.pending, false, 'an empty final transcript ends the turn too');
}

// ── 2. "voice": holding line only after 1.5 s, never on two consecutive turns
{
  assert.equal(STALL_AFTER_MS, 1500);
  const gate = createStallGate();
  const logs: string[] = [];
  const turn = async (turnId: number, delayMs: number) => {
    const spoken: string[] = [];
    const p = runClientAgentVoiceTurn({
      endpoint: ENDPOINT, callId: CALL_ID, turnId, language: 'fr', callerSaid: 'q', history: [],
      speak: async (t) => { spoken.push(t); },
      ask: askAfter(delayMs), stallGate: gate, log: (l) => logs.push(l),
    });
    await flush();
    mock.timers.tick(delayMs);
    await flush();
    assert.equal(await p, 'answered');
    return spoken;
  };
  assert.deepEqual(await turn(1, 1000), ['Réponse.'], 'answer at 1.0 s → no holding line');
  assert.deepEqual(await turn(2, 2000), [STALL_FR, 'Réponse.'], 'answer at 2.0 s → one holding line');
  assert.deepEqual(await turn(3, 2000), ['Réponse.'], 'two slow turns in a row → only the first');
  assert.deepEqual(await turn(4, 2000), [STALL_FR, 'Réponse.'], 'the third slow turn → holding line again');

  // The answer arrives while the holding line is being said: it plays after.
  const order: string[] = [];
  let endHolding!: () => void;
  const p = runClientAgentVoiceTurn({
    endpoint: ENDPOINT, callId: CALL_ID, turnId: 5, language: 'fr', callerSaid: 'q', history: [],
    speak: async (t) => {
      order.push(`start ${t}`);
      if (t === STALL_FR) await new Promise<void>((r) => (endHolding = r));
      order.push(`end ${t}`);
    },
    ask: askAfter(1600), stallGate: createStallGate(), log: () => {},
  });
  await flush();
  mock.timers.tick(1500);
  await flush();
  mock.timers.tick(100);
  await flush();
  assert.deepEqual(order, [`start ${STALL_FR}`], 'the answer waits for the holding line');
  endHolding();
  assert.equal(await p, 'answered');
  assert.deepEqual(order, [`start ${STALL_FR}`, `end ${STALL_FR}`, 'start Réponse.', 'end Réponse.'], 'no overlap');
}

// ── 3. "lead": the same rule for the tool's holding line ───────────────────
{
  const events: string[] = [];
  const tool = (delays: number[]) => {
    let i = 0;
    const t = makeClientAgentTools({
      webhook: ENDPOINT,
      getCallId: () => CALL_ID,
      getLanguage: () => 'fr',
      getCallerSaid: () => 'q',
      getHistory: () => [],
      startStall: () => {
        events.push('stall');
        return () => events.push('cancel');
      },
      ask: (async (e: unknown, r: ClientAgentRequest) => askAfter(delays[i++]!)(e, r)) as never,
    }).ask_client_agent as unknown as { execute: (a: unknown, o: unknown) => Promise<string> };
    return async (delayMs: number) => {
      const p = t.execute({ question: 'q' }, {});
      await flush();
      mock.timers.tick(delayMs);
      await p;
    };
  };
  const log = console.log;
  console.log = () => {};
  const call = tool([1000, 2000, 2000, 2000]);
  await call(1000);
  assert.deepEqual(events, [], 'answer at 1.0 s → no holding line');
  await call(2000);
  assert.deepEqual(events, ['stall', 'cancel'], 'answer at 2.0 s → one holding line');
  await call(2000);
  assert.deepEqual(events, ['stall', 'cancel'], 'two slow turns in a row → only the first');
  await call(2000);
  assert.deepEqual(events, ['stall', 'cancel', 'stall', 'cancel'], 'the third slow turn → again');
  console.log = log;
}

// ── 4. "voice": a stale reply is dropped; a single turn is spoken ─────────
{
  const spoken: string[] = [];
  const logs: string[] = [];
  const done: number[] = [];
  const queue = createVoiceTurnQueue(async (callerSaid, turnId, turn) => {
    await runClientAgentVoiceTurn({
      endpoint: ENDPOINT, callId: CALL_ID, turnId, language: 'fr', callerSaid, history: [],
      speak: async (t) => { spoken.push(t); },
      ask: askAfter(800, `Réponse à « ${callerSaid} ».`), isStale: turn.isStale, log: (l) => logs.push(l),
    });
    done.push(turnId);
  }, () => {});

  queue.submit('Bonjour');
  await flush();
  queue.submit('Je voudrais un rendez-vous');
  mock.timers.tick(800);
  await flush();
  mock.timers.tick(800);
  await flush();
  assert.deepEqual(done, [1, 2]);
  assert.deepEqual(spoken, ['Réponse à « Je voudrais un rendez-vous ».'], "two quick utterances → only the second turn's reply");
  assert.ok(logs.includes('[voice] turn 1 reply dropped (stale)'));

  spoken.length = 0;
  queue.submit('Merci');
  await flush();
  mock.timers.tick(800);
  await flush();
  assert.deepEqual(spoken, ['Réponse à « Merci ».'], 'a single turn → spoken');
  assert.ok(logs.every((l) => !/Bonjour|rendez-vous|Merci|agent\.example|mock-secret/.test(l)), 'no words, url or secret in logs');
}

// ── 5. the session closes mid-turn: one info line, nothing spoken, no error
{
  const run = async (closeWhen: 'before_reply' | 'during_speak') => {
    let closed = false;
    const lines: Array<[string, string]> = [];
    const spoken: string[] = [];
    const p = runClientAgentVoiceTurn({
      endpoint: ENDPOINT, callId: CALL_ID, turnId: 4, language: 'fr', callerSaid: 'Au revoir', history: [],
      speak: async (t) => {
        if (closeWhen === 'during_speak') {
          closed = true;
          throw new Error('AgentSession is not running');
        }
        spoken.push(t);
      },
      ask: askAfter(500), isClosed: () => closed,
      log: (l) => lines.push(['info', l]),
    });
    await flush();
    if (closeWhen === 'before_reply') closed = true;
    mock.timers.tick(500);
    const outcome: VoiceTurnOutcome = await p;
    return { outcome, lines: lines.map(([, l]) => l), spoken };
  };
  const a = await run('before_reply');
  assert.equal(a.outcome, 'discarded');
  assert.deepEqual(a.lines, ['[voice] turn 4 discarded (session closed)'], 'one info line only');
  assert.deepEqual(a.spoken, []);
  const b = await run('during_speak');
  assert.equal(b.outcome, 'discarded');
  assert.deepEqual(
    b.lines,
    ['[client_agent] voice turn 4 → ok in 500ms', '[voice] turn 4 discarded (session closed)'],
    'never "ok" then "error" for the same turn',
  );
  assert.ok(b.lines.every((l) => !/error/i.test(l)));
}

// ── 6. reach (#45): a reply dropped as stale, or discarded on a closed
// session, still counts as reached: the agent DID answer
{
  for (const kind of ['stale', 'closed'] as const) {
    const reach = createClientAgentReachTracker();
    const spoken: string[] = [];
    const p = runClientAgentVoiceTurn({
      endpoint: ENDPOINT, callId: CALL_ID, turnId: 1, language: 'fr', callerSaid: 'Bonjour', history: [],
      speak: async (t) => { spoken.push(t); },
      ask: askAfter(300), log: () => {}, reach,
      ...(kind === 'stale' ? { isStale: () => true } : { isClosed: () => true }),
    });
    await flush();
    mock.timers.tick(300);
    assert.equal(await p, kind === 'stale' ? 'stale' : 'discarded');
    assert.deepEqual(spoken, []);
    assert.equal(reach.reached, true, `${kind}: not spoken, still reached`);
  }
  const failed = createClientAgentReachTracker();
  const q = runClientAgentVoiceTurn({
    endpoint: ENDPOINT, callId: CALL_ID, turnId: 1, language: 'fr', callerSaid: 'Bonjour', history: [],
    speak: async () => {}, log: () => {}, reach: failed, isStale: () => true,
    ask: (async () => ({ answer: null, elapsedMs: 1, failure: 'http' })) as never,
  });
  await flush();
  await q;
  assert.equal(failed.reached, false, 'no answer → not reached, stale or not');
}

mock.timers.reset();
console.log('ALL CLIENT-AGENT POLISH TESTS PASSED');
