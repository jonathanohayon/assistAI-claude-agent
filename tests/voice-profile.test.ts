import assert from 'node:assert/strict';

import { geminiLiveOptions } from '../src/realtime-provider.js';
import {
  DEFAULT_VOICE_PROFILE,
  mapGemini,
  mapGrok,
  mapOpenAI,
  mapSession,
  profileInstructions,
  resolveVoiceProfile,
} from '../src/voice-profile.js';

const ctx = { model: 'gpt-realtime-2', speed: 1.1, primaryLanguage: 'he', webhookMode: false };
const D = DEFAULT_VOICE_PROFILE;

// ── SNAPSHOTS: the default profile reproduces today's options exactly ──
// OpenAI: the turnDetection object that was hard-coded in agent.ts
assert.deepEqual(mapOpenAI(D, ctx), {
  turnDetection: { type: 'server_vad', threshold: 0.75, prefix_padding_ms: 150, silence_duration_ms: 350, create_response: true },
  speed: 1.1,
  transcriptionLanguage: 'he',
});
// BYO mode keeps create_response false, as before
assert.equal(mapOpenAI(D, { ...ctx, webhookMode: true }).turnDetection['create_response'], false);
// reasoning by model, as before (#19): none on 2, low on 2.1
assert.equal(mapOpenAI(D, ctx).reasoning, undefined);
assert.deepEqual(mapOpenAI(D, { ...ctx, model: 'gpt-realtime-2.1' }).reasoning, { effort: 'low' });
// Gemini: identical to the realtimeInputConfig shipped in #18
const today = geminiLiveOptions({ voice: 'marin', primaryLanguage: 'he' }, {});
const g = mapGemini(D, ctx);
assert.deepEqual(g.automaticActivityDetection, today.realtimeInputConfig.automaticActivityDetection);
assert.equal(g.language, today.language);
assert.equal(g.activityHandling, undefined);
// Grok: nothing overridden (plugin's xAI-tuned VAD, xAI default reasoning)
assert.deepEqual(mapGrok(D, ctx), {});
// Session: SDK interruption defaults untouched, 30 s idle, 30 min max
assert.deepEqual(mapSession(D), { idleHangupMs: 30_000, maxDurationMs: 30 * 60_000 });
// Prompt unchanged
for (const p of ['openai', 'gemini', 'xai'] as const) assert.equal(profileInstructions(D, p, ctx), '');
// An absent / empty / corrupt profile is the default
assert.deepEqual(resolveVoiceProfile(undefined), D);
assert.deepEqual(resolveVoiceProfile({}), D);
assert.deepEqual(resolveVoiceProfile({ turnSensitivity: 9, pace: 'warp', grokReasoning: 'medium' }), D);

// ── Settings take effect ──
const p = resolveVoiceProfile({
  turnSensitivity: 1, bargeIn: false, minInterruptionMs: 900, idleHangupSec: 45, maxDurationMin: 10,
  pace: 'fast', fillers: false, languageLock: true, languageHint: 'fr',
  keyTerms: ['Botox'], pronunciations: [{ term: 'Tamara', sayAs: 'ta-MA-ra' }],
  openaiTurnMode: 'semantic_vad', openaiEagerness: 'low', openaiNoiseReduction: 'far_field',
  openaiReasoning: 'high', grokReasoning: 'none', voiceOverrides: { xai: 'ara', gemini: '' },
});
const o = mapOpenAI(p, ctx);
assert.deepEqual(o.turnDetection, { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false });
assert.equal(o.speed, 1.26); // 1.1 x 1.15 = 1.2649..., rounded to 2 decimals
assert.deepEqual(o.noiseReduction, { type: 'far_field' });
assert.deepEqual(o.reasoning, { effort: 'high' });
assert.equal(o.transcriptionLanguage, 'fr');
// sensitivity 1 waits longer before answering
assert.equal(mapOpenAI({ ...D, turnSensitivity: 1 }, ctx).turnDetection['silence_duration_ms'], 800);
assert.equal(mapOpenAI({ ...D, turnSensitivity: 5 }, ctx).turnDetection['silence_duration_ms'], 180);
assert.equal(mapGemini(p, ctx).activityHandling, 'NO_INTERRUPTION');
assert.equal(mapGemini(p, ctx).automaticActivityDetection.silenceDurationMs, 800);
assert.deepEqual(mapGrok(p, ctx).reasoningEffort, 'none');
assert.equal(mapGrok(p, ctx).turnDetection?.['interrupt_response'], false);
assert.deepEqual(mapSession(p), { interruption: { enabled: false, minDuration: 900 }, idleHangupMs: 45_000, maxDurationMs: 600_000 });
assert.deepEqual(p.voiceOverrides, { xai: 'ara' }); // empty override ignored
const instr = profileInstructions(p, 'xai', ctx);
assert.match(instr, /brisk/); // pace as an instruction on non-OpenAI engines
assert.match(instr, /Never use filler/);
assert.match(instr, /Always answer in French/);
assert.match(instr, /"Tamara" is pronounced "ta-MA-ra"/);
assert.match(instr, /Botox/);
assert.doesNotMatch(profileInstructions(p, 'openai', ctx), /brisk/); // OpenAI uses speed
// speed stays within OpenAI's 0.5–1.5
assert.equal(mapOpenAI({ ...D, pace: 'fast' }, { ...ctx, speed: 1.5 }).speed, 1.5);

console.log('ALL VOICE-PROFILE TESTS PASSED');
