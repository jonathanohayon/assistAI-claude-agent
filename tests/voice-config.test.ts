// Voice contract on the worker (src/voice-config.ts). PROOF: from the web's
// REAL route payloads (7 mocked cases, tests/fixtures/voice-route-payloads.json,
// captured from the route handlers of web #185 on a throwaway DB), the worker
// builds the SAME session settings from `voiceConfig` as from the legacy
// fields, for every engine. Plus drift guards on the vendored contract.json.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { geminiLiveOptions, grokOptions } from '../src/realtime-provider.js';
import {
  engineFromLegacy,
  engineFromVoiceConfig,
  MALE_VOICE_IDS,
  resolveEngineSettings,
  VOICE_CONTRACT,
  type EngineSettings,
} from '../src/voice-config.js';
import {
  DEFAULT_VOICE_PROFILE,
  mapGemini,
  mapGrok,
  mapOpenAI,
  mapSession,
  profileInstructions,
  resolveVoiceProfile,
} from '../src/voice-profile.js';

const payloads = JSON.parse(
  readFileSync(new URL('./fixtures/voice-route-payloads.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;

/** Everything the worker builds the voice session from (agent.ts). */
function session(e: EngineSettings, primaryLanguage: unknown) {
  const profile = resolveVoiceProfile(e.voiceProfile);
  const ctx = { model: e.model, speed: e.speed, primaryLanguage: primaryLanguage as string, webhookMode: false };
  const env = {};
  return {
    provider: e.realtimeProvider,
    model: e.model,
    voice: e.voice,
    speed: e.speed,
    noiseReductionLevel: e.noiseReductionLevel,
    profile,
    openai: mapOpenAI(profile, ctx),
    gemini: mapGemini(profile, ctx),
    grok: mapGrok(profile, ctx),
    session: mapSession(profile),
    instructions: (['openai', 'gemini', 'xai'] as const).map((p) => profileInstructions(profile, p, ctx)),
    geminiVoice: geminiLiveOptions({ voice: e.voice, primaryLanguage: primaryLanguage as string }, env).voice,
    grokVoice: grokOptions({ voice: e.voice, primaryLanguage: primaryLanguage as string } as never, env).voice,
  };
}

assert.equal(Object.keys(payloads).length, 7);
for (const [name, p] of Object.entries(payloads)) {
  assert.ok(p['voiceConfig'], `${name}: web serves voiceConfig`);
  const fromContract = engineFromVoiceConfig(p['voiceConfig']);
  assert.ok(fromContract, `${name}: voiceConfig is a valid v1`);
  assert.equal(resolveEngineSettings(p).source, 'voiceConfig', `${name}: contract wins`);
  assert.deepEqual(resolveEngineSettings(p).mismatch, [], `${name}: shadow compare finds no drift`);
  const { voiceConfig: _vc, ...legacyOnly } = p;
  assert.equal(resolveEngineSettings(legacyOnly).source, 'legacy', `${name}: legacy fallback`);
  assert.deepEqual(
    session(fromContract, p['primaryLanguage']),
    session(engineFromLegacy(legacyOnly), p['primaryLanguage']),
    `${name}: same session settings from voiceConfig and from the legacy fields`,
  );
}
// the cases really differ from each other (the proof isn't trivially on defaults)
assert.equal(engineFromVoiceConfig(payloads['inboundProfile']!['voiceConfig'])!.realtimeProvider, 'xai');
assert.equal(engineFromVoiceConfig(payloads['campaignSliders']!['voiceConfig'])!.speed, 1.167);

// shadow compare reports a real drift between voiceConfig and the legacy fields
{
  const p = payloads['inboundProfile']!;
  assert.deepEqual(resolveEngineSettings({ ...p, speed: 1.2 }).mismatch, ['speed']);
  assert.deepEqual(resolveEngineSettings({ ...p, voice: 'ash', realtimeProvider: 'openai' }).mismatch, ['realtimeProvider', 'voice']);
  assert.deepEqual(resolveEngineSettings({ voiceConfig: p['voiceConfig'] }).mismatch, [], 'no legacy fields → nothing to compare');
}

// invalid / foreign voiceConfig → legacy path, as before
for (const bad of [null, 'x', {}, { version: 2 }, { version: 1, voiceId: 'marin', engine: 'gpt', advanced: {} }, { version: 1, voiceId: '', engine: 'auto', advanced: {} }]) {
  assert.equal(engineFromVoiceConfig(bad), null);
  assert.equal(resolveEngineSettings({ voiceConfig: bad, voice: 'ash' }).voice, 'ash');
}
// an old web (no voiceConfig): exactly the legacy defaults
{
  const { source, mismatch, ...rest } = resolveEngineSettings({});
  assert.deepEqual(mismatch, []);
  assert.equal(source, 'legacy');
  assert.deepEqual(rest, engineFromLegacy({}));
}
assert.deepEqual(resolveVoiceProfile(engineFromLegacy({}).voiceProfile), DEFAULT_VOICE_PROFILE);

// ── Drift guards on the vendored contract ───────────────────────────────
// 1) the web's own mapping examples: the worker maps them identically
assert.ok(VOICE_CONTRACT.examples.length >= 4);
for (const ex of VOICE_CONTRACT.examples) {
  const mine = engineFromVoiceConfig(ex.voice)!;
  assert.deepEqual(
    { ...mine, voiceProfile: resolveVoiceProfile(mine.voiceProfile) },
    { ...ex.engine, voiceProfile: resolveVoiceProfile(ex.engine.voiceProfile) },
    'worker mapping differs from the web toEngineSettings (contract.json example)',
  );
  assert.deepEqual(mine.voiceProfile, ex.engine.voiceProfile, 'profile fields differ from the web');
}
// 2) shared data the worker also hard-codes elsewhere
assert.deepEqual(resolveVoiceProfile((engineFromVoiceConfig(VOICE_CONTRACT.defaultVoice)!).voiceProfile), DEFAULT_VOICE_PROFILE);
// 3) gender table: Gemini/Grok fallback voices unchanged for every voice
const OLD_MALE = new Set(['ballad', 'verse', 'alloy', 'echo', 'fable', 'onyx', 'ash']);
for (const id of Object.keys(VOICE_CONTRACT.voiceGender)) {
  const g = geminiLiveOptions({ voice: id, primaryLanguage: 'fr' }, {}).voice;
  const x = grokOptions({ voice: id, primaryLanguage: 'fr' } as never, {}).voice;
  const male = OLD_MALE.has(id);
  if (!['marin', 'cedar', 'coral'].includes(id)) {
    assert.equal(g, male ? 'Charon' : 'Kore', `gemini voice for ${id}`);
    assert.equal(x, male ? 'rex' : 'eve', `grok voice for ${id}`);
  }
  assert.equal(MALE_VOICE_IDS.has(id), VOICE_CONTRACT.voiceGender[id] === 'm');
}
// 4) the vendored copy IS the web's (fails when the two sides differ)
{
  const mine = readFileSync(new URL('../src/voice/contract.json', import.meta.url), 'utf8');
  const local = process.env['WEB_VOICE_CONTRACT'];
  if (local) {
    assert.equal(mine, readFileSync(local, 'utf8'), 'src/voice/contract.json differs from the web copy');
  } else if (process.env['VOICE_CONTRACT_OFFLINE'] !== '1') {
    const url = 'https://raw.githubusercontent.com/jonathanohayon/assistAI-claude/main/lib/voice/contract.json';
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res || res.status >= 500) {
      // Offline / GitHub down: skip loudly; a REAL difference still fails below.
      console.warn(`[voice-config.test] WARNING: web contract unreachable (${res?.status ?? 'network'}), drift not checked`);
    } else {
      assert.equal(res.status, 200, `web contract not on web main (${res.status})`);
      assert.equal(mine, await res.text(), 'src/voice/contract.json differs from web main lib/voice/contract.json — re-vendor it');
    }
  } else {
    console.warn('[voice-config.test] VOICE_CONTRACT_OFFLINE=1: web copy not compared');
  }
}

console.log('ALL VOICE-CONFIG TESTS PASSED');
