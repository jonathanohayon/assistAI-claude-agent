// The account's primary language reaches the call. fetchConfig used to drop
// `primaryLanguage` from the web payload, so every reader fell back to its own
// default ('fr' for most, 'en' for the T5c lead tool). Now a supported code is
// copied; absent or invalid → no key, i.e. today's config byte for byte.
// Mock data only; every HTTP call is a stubbed fetch.
// Run with:  npx tsx tests/primary-language.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env['INTERNAL_SECRET'] = 'mock';
process.env['APP_URL'] = 'http://web.test';

const { fetchConfig, primaryLanguageField } = await import('../src/config-fetcher.js');
const { DEFAULT_VOICE_PROFILE, mapGemini, mapGrok, mapOpenAI, profileInstructions } = await import('../src/voice-profile.js');
const { geminiLiveOptions, providerLanguageWarning } = await import('../src/realtime-provider.js');
const { stallLine } = await import('../src/agent-webhook.js');
const { apologyLine } = await import('../src/brain-mode.js');
const { buildClientAgentRequest } = await import('../src/client-agent.js');
type FetchedConfig = Awaited<ReturnType<typeof fetchConfig>>;

// ── 1. primaryLanguageField: valid → copied, anything else → no key ──
for (const l of ['fr', 'he', 'en'] as const) assert.deepEqual(primaryLanguageField(l), { primaryLanguage: l }, l);
for (const bad of [undefined, null, '', 'de', 'FR', 'he-IL', ' fr', 1, {}, ['fr']]) {
  assert.deepEqual(primaryLanguageField(bad), {}, `invalid ${JSON.stringify(bad)} → no key`);
}

// ── 2. fetchConfig copies it from the tenant payload ──
let payload: Record<string, unknown> = {};
globalThis.fetch = (async (url: string) => {
  const path = new URL(url).pathname;
  if (path.startsWith('/api/vox')) return new Response('{}', { status: 404 });
  if (path === '/api/events') return new Response('{"ok":true}', { status: 200 });
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const BASE = { instructions: 'Mock tenant prompt.', agentName: 'Mock', voice: 'marin', speed: 1 };
const ORIGINS = [
  { kind: 'sip', calledNumber: '+97220000000', channel: 'pstn' },
  { kind: 'web', userId: 'mock-user' },
  { kind: 'campaign', campaignId: 'mock-c', contactId: 'mock-k', userId: '' },
  { kind: 'outbound_test', agentId: 'mock-a' },
] as const;
const load = async (lang: unknown, origin: (typeof ORIGINS)[number] = ORIGINS[0]): Promise<FetchedConfig> => {
  payload = lang === ABSENT ? { ...BASE } : { ...BASE, primaryLanguage: lang };
  return fetchConfig(origin as never);
};
const ABSENT = Symbol('absent');

// Today's config: the payload without the field. The fix must leave it as is.
const today = await load(ABSENT);
assert.equal('primaryLanguage' in today, false, 'absent field → no key');

for (const origin of ORIGINS) {
  for (const l of ['fr', 'he', 'en'] as const) {
    const cfg = await load(l, origin);
    assert.equal(cfg.primaryLanguage, l, `${origin.kind} ${l}: copied`);
    // Only that key differs from the absent-field config.
    const { primaryLanguage: _l, ...rest } = cfg;
    assert.deepEqual(rest, await load(ABSENT, origin), `${origin.kind} ${l}: nothing else changes`);
  }
  for (const bad of [ABSENT, null, '', 'de', 'FR']) {
    const cfg = await load(bad, origin);
    assert.equal('primaryLanguage' in cfg, false, `${origin.kind} ${String(bad)}: no key`);
    // Byte-identical to today's config for this origin.
    assert.equal(JSON.stringify(cfg), JSON.stringify(await load(ABSENT, origin)), `${origin.kind} ${String(bad)}: identical`);
  }
}

// ── 3. Every language-dependent setting of a call, from the config ──
// The mapping functions are the real ones agent.ts calls. The inline reads in
// agent.ts (`cfg.primaryLanguage ?? 'fr' | 'en'`) are mirrored here; section 4
// pins them to the source so this table cannot drift from the code.
const D = DEFAULT_VOICE_PROFILE;
function settings(cfg: FetchedConfig) {
  const ctx = { model: cfg.model, speed: cfg.speed, primaryLanguage: cfg.primaryLanguage, webhookMode: false };
  const fr = cfg.primaryLanguage ?? 'fr'; // agent.ts: speakVerbatim, legacy webhook, client-agent voice/opening
  const en = cfg.primaryLanguage ?? 'en'; // agent.ts: T5c lead tool (getLanguage, holding line)
  return {
    openaiTranscriptionLanguage: mapOpenAI(D, ctx).transcriptionLanguage,
    geminiLanguage: mapGemini(D, ctx).language,
    geminiLiveOptionsLanguage: geminiLiveOptions(cfg, {}).language,
    grokMapped: mapGrok(D, ctx),
    grokHebrewWarning: providerLanguageWarning('xai', cfg.primaryLanguage),
    languageLockLine: profileInstructions({ ...D, languageLock: true }, 'openai', ctx),
    defaultProfileInstructions: profileInstructions(D, 'openai', ctx),
    speakVerbatimTtsLanguage: fr,
    legacyWebhookLanguage: fr,
    legacyWebhookStall: stallLine(fr),
    clientAgentOpeningLanguage: fr,
    clientAgentVoiceLanguage: fr,
    clientAgentVoiceRequest: buildClientAgentRequest({ callId: 'mock', turnId: 1, language: fr, question: 'q', callerSaid: 'q', history: [] }).language,
    clientAgentVoiceStall: stallLine(fr),
    clientAgentVoiceApology: apologyLine(fr),
    leadToolLanguage: en,
    leadToolStall: stallLine(en),
    leadToolTtsLanguage: en,
  };
}

// BEFORE: what EVERY tenant call got until now (the field was never copied).
const BEFORE = {
  openaiTranscriptionLanguage: 'fr',
  geminiLanguage: 'fr-FR',
  geminiLiveOptionsLanguage: 'fr-FR',
  grokMapped: {},
  grokHebrewWarning: null,
  languageLockLine: '### Voice profile\n- Always answer in French, even if the caller switches language.',
  defaultProfileInstructions: '',
  speakVerbatimTtsLanguage: 'fr',
  legacyWebhookLanguage: 'fr',
  legacyWebhookStall: 'Un instant, je vérifie.',
  clientAgentOpeningLanguage: 'fr',
  clientAgentVoiceLanguage: 'fr',
  clientAgentVoiceRequest: 'fr',
  clientAgentVoiceStall: 'Un instant, je vérifie.',
  clientAgentVoiceApology: "Désolée, je n'arrive pas à vérifier pour le moment. Pouvez-vous répéter ?",
  leadToolLanguage: 'en',
  leadToolStall: 'One moment, let me check.',
  leadToolTtsLanguage: 'en',
};
const STALL = { fr: 'Un instant, je vérifie.', he: 'רגע אחד, אני בודקת.', en: 'One moment, let me check.' };
const APOLOGY = {
  fr: "Désolée, je n'arrive pas à vérifier pour le moment. Pouvez-vous répéter ?",
  he: 'סליחה, אני לא מצליחה לבדוק כרגע. אפשר לחזור על זה?',
  en: "Sorry, I can't check that right now. Could you say it again?",
};
const NAME = { fr: 'French', he: 'Hebrew', en: 'English' };
const BCP = { fr: 'fr-FR', he: 'he-IL', en: 'en-US' };
const after = (l: 'fr' | 'he' | 'en') => ({
  openaiTranscriptionLanguage: l,
  geminiLanguage: BCP[l],
  geminiLiveOptionsLanguage: BCP[l],
  grokMapped: {},
  grokHebrewWarning: l === 'he' ? 'Grok Voice does not list Hebrew as a supported language; quality may be poor' : null,
  languageLockLine: `### Voice profile\n- Always answer in ${NAME[l]}, even if the caller switches language.`,
  defaultProfileInstructions: '',
  speakVerbatimTtsLanguage: l,
  legacyWebhookLanguage: l,
  legacyWebhookStall: STALL[l],
  clientAgentOpeningLanguage: l,
  clientAgentVoiceLanguage: l,
  clientAgentVoiceRequest: l,
  clientAgentVoiceStall: STALL[l],
  clientAgentVoiceApology: APOLOGY[l],
  leadToolLanguage: l,
  leadToolStall: STALL[l],
  leadToolTtsLanguage: l,
});

// Absent / invalid: byte-identical to BEFORE (the snapshot of today's call).
for (const bad of [ABSENT, null, 'de']) {
  assert.equal(JSON.stringify(settings(await load(bad))), JSON.stringify(BEFORE), `${String(bad)}: settings unchanged`);
}
for (const l of ['fr', 'he', 'en'] as const) assert.deepEqual(settings(await load(l)), after(l), `${l}: settings`);

// The fr behaviour change: only the T5c lead-tool sites move ('en' → 'fr').
const frBefore = BEFORE as Record<string, unknown>;
const frAfter = settings(await load('fr')) as Record<string, unknown>;
const changedForFr = Object.keys(frAfter).filter((k) => JSON.stringify(frAfter[k]) !== JSON.stringify(frBefore[k]));
assert.deepEqual(changedForFr, ['leadToolLanguage', 'leadToolStall', 'leadToolTtsLanguage'], 'fr: only the en-fallback sites change');

// ── 4. Source guards: the readers and their fallbacks are the ones above ──
const agentSrc = readFileSync(new URL('../agent.ts', import.meta.url), 'utf8');
const count = (s: string) => agentSrc.split(s).length - 1;
assert.equal(count("cfg.primaryLanguage ?? 'fr'"), 8, "agent.ts: eight 'fr' fallbacks");
assert.equal(count("cfg.primaryLanguage ?? 'en'"), 3, "agent.ts: three 'en' fallbacks (T5c lead tool)");
assert.equal(count('cfg.primaryLanguage'), 15, 'agent.ts: no reader outside this table');
// Per-call context, the pre-rendered opener and the lang_enforce directive do not read it.
for (const f of ['../src/per-call-context.ts', '../src/greeting-player.ts']) {
  assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /primaryLanguage/, `${f} does not read it`);
}
assert.match(agentSrc, /'🇮🇱 RÉPONDS EN HÉBREU\.'\s*:\s*'🇫🇷 RÉPONDS DANS LA LANGUE DE LA CLIENTE\.'/, 'lang_enforce is sniffed, not configured');

console.log('primary-language: all assertions passed');
