import assert from 'node:assert/strict';

import {
  DEFAULT_GEMINI_LIVE_MODEL,
  geminiLiveOptions,
  resolveRealtimeProvider,
} from '../src/realtime-provider.js';

// PRODUCTION: no REALTIME_PROVIDER set -> OpenAI, exactly as before
assert.equal(resolveRealtimeProvider({}), 'openai');
assert.equal(resolveRealtimeProvider({ REALTIME_PROVIDER: '' }), 'openai');
// only an explicit 'gemini' switches; typos and unknown values stay on OpenAI
assert.equal(resolveRealtimeProvider({ REALTIME_PROVIDER: 'gemini' }), 'gemini');
assert.equal(resolveRealtimeProvider({ REALTIME_PROVIDER: ' Gemini ' }), 'gemini');
assert.equal(resolveRealtimeProvider({ REALTIME_PROVIDER: 'gemni' }), 'openai');
assert.equal(resolveRealtimeProvider({ REALTIME_PROVIDER: 'xai' }), 'openai');

// Gemini options: model, voice mapping, language, VAD
const he = geminiLiveOptions({ voice: 'marin', primaryLanguage: 'he' }, {});
assert.equal(he.model, DEFAULT_GEMINI_LIVE_MODEL);
assert.equal(he.voice, 'Kore'); // OpenAI voice name -> Gemini default
assert.equal(he.language, 'he-IL');
assert.equal(he.apiKey, undefined); // plugin then reads GOOGLE_API_KEY itself
assert.equal(he.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 350);
assert.equal(he.realtimeInputConfig.automaticActivityDetection.prefixPaddingMs, 150);

assert.equal(geminiLiveOptions({ voice: 'Aoede', primaryLanguage: 'fr' }, {}).voice, 'Aoede');
assert.equal(geminiLiveOptions({ voice: 'cedar' }, { GEMINI_VOICE: 'Leda' }).voice, 'Leda');
assert.equal(geminiLiveOptions({ primaryLanguage: 'en' }, {}).language, 'en-US');
assert.equal(geminiLiveOptions({}, {}).language, 'fr-FR');
assert.equal(geminiLiveOptions({}, { GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview' }).model, 'gemini-3.1-flash-live-preview');

// the key is passed through when set, and never invented
assert.equal(geminiLiveOptions({}, { GOOGLE_API_KEY: ' k ' }).apiKey, 'k');

console.log('ALL REALTIME-PROVIDER TESTS PASSED');
