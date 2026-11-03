import assert from 'node:assert/strict';

import {
  DEFAULT_GEMINI_LIVE_MODEL,
  geminiLiveOptions,
  grokOptions,
  openaiReasoning,
  providerLanguageWarning,
  resolveRealtimeProvider,
  withKeyFallback,
} from '../src/realtime-provider.js';

// PRODUCTION: no tenant setting, no env override -> OpenAI, exactly as before
assert.equal(resolveRealtimeProvider(undefined, {}), 'openai');
assert.equal(resolveRealtimeProvider(null, {}), 'openai');
assert.equal(resolveRealtimeProvider('openai', {}), 'openai');
assert.equal(resolveRealtimeProvider('something-else', {}), 'openai');
// the tenant's admin-only setting picks the engine
assert.equal(resolveRealtimeProvider('gemini', {}), 'gemini');
assert.equal(resolveRealtimeProvider('xai', {}), 'xai');
// staging env override wins over the tenant; typos are ignored
assert.equal(resolveRealtimeProvider('openai', { REALTIME_PROVIDER: ' Gemini ' }), 'gemini');
assert.equal(resolveRealtimeProvider('gemini', { REALTIME_PROVIDER: 'openai' }), 'openai');
assert.equal(resolveRealtimeProvider('xai', { REALTIME_PROVIDER: 'gemni' }), 'xai');
assert.equal(resolveRealtimeProvider(undefined, { REALTIME_PROVIDER: '' }), 'openai');

// missing key -> OpenAI fallback, naming the variable (never a value)
assert.deepEqual(withKeyFallback('gemini', {}), { provider: 'openai', missingKey: 'GOOGLE_API_KEY' });
assert.deepEqual(withKeyFallback('xai', { XAI_API_KEY: '  ' }), { provider: 'openai', missingKey: 'XAI_API_KEY' });
assert.deepEqual(withKeyFallback('xai', { XAI_API_KEY: 'k' }), { provider: 'xai', missingKey: null });
assert.deepEqual(withKeyFallback('openai', {}), { provider: 'openai', missingKey: null });

// reasoning: only the admin-only 2.1 models get it; gpt-realtime-2 unchanged
assert.equal(openaiReasoning('gpt-realtime-2'), undefined);
assert.deepEqual(openaiReasoning('gpt-realtime-2.1'), { effort: 'low' });
assert.deepEqual(openaiReasoning('gpt-realtime-2.1-mini'), { effort: 'low' });

// Grok: pinned to grok-voice-3.0 (plugin default is a deprecated model)
assert.equal(grokOptions({}, {}).model, 'grok-voice-3.0');
assert.equal(grokOptions({ voice: 'marin' }, {}).voice, 'eve');
assert.equal(grokOptions({ voice: 'cedar' }, {}).voice, 'rex');
assert.equal(grokOptions({ voice: 'coral' }, {}).voice, 'ara');
assert.equal(grokOptions({ voice: 'echo' }, {}).voice, 'rex'); // other male
assert.equal(grokOptions({ voice: 'shimmer' }, {}).voice, 'eve'); // other female
assert.equal(grokOptions({ voice: 'Leo' }, {}).voice, 'leo'); // a Grok voice is kept
assert.equal(grokOptions({}, { GROK_VOICE_MODEL: 'grok-voice-latest' }).model, 'grok-voice-latest');
assert.equal(providerLanguageWarning('xai', 'he') !== null, true);
assert.equal(providerLanguageWarning('xai', 'fr'), null);
assert.equal(providerLanguageWarning('gemini', 'he'), null);

// Gemini options: model, voice mapping, language, VAD
const he = geminiLiveOptions({ voice: 'marin', primaryLanguage: 'he' }, {});
assert.equal(he.model, DEFAULT_GEMINI_LIVE_MODEL);
assert.equal(he.voice, 'Sulafat'); // marin (default, female) -> closest Gemini voice
assert.equal(he.language, 'he-IL');
assert.equal(he.apiKey, undefined); // plugin then reads GOOGLE_API_KEY itself
assert.equal(he.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 350);
assert.equal(he.realtimeInputConfig.automaticActivityDetection.prefixPaddingMs, 150);

assert.equal(geminiLiveOptions({ voice: 'Aoede', primaryLanguage: 'fr' }, {}).voice, 'Aoede');
assert.equal(geminiLiveOptions({ voice: 'cedar' }, { GEMINI_VOICE: 'Leda' }).voice, 'Leda');
// voice table: gender is preserved
assert.equal(geminiLiveOptions({ voice: 'cedar' }, {}).voice, 'Achird');
assert.equal(geminiLiveOptions({ voice: 'coral' }, {}).voice, 'Aoede');
assert.equal(geminiLiveOptions({ voice: 'shimmer' }, {}).voice, 'Kore'); // other female
assert.equal(geminiLiveOptions({ voice: 'echo' }, {}).voice, 'Charon'); // other male
assert.equal(geminiLiveOptions({}, {}).voice, 'Kore'); // no voice set
assert.equal(geminiLiveOptions({ primaryLanguage: 'en' }, {}).language, 'en-US');
assert.equal(geminiLiveOptions({}, {}).language, 'fr-FR');
assert.equal(geminiLiveOptions({}, { GEMINI_LIVE_MODEL: 'gemini-3.1-flash-live-preview' }).model, 'gemini-3.1-flash-live-preview');

// the key is passed through when set, and never invented
assert.equal(geminiLiveOptions({}, { GOOGLE_API_KEY: ' k ' }).apiKey, 'k');

console.log('ALL REALTIME-PROVIDER TESTS PASSED');
