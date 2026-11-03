/**
 * Which speech-to-speech model answers the phone.
 *
 * Per tenant: `realtimeProvider` from /api/agent/config (admin-only setting,
 * 'openai' when unset). REALTIME_PROVIDER in the env overrides it, for
 * worker-staging only. If the chosen provider's API key is missing, the call
 * falls back to OpenAI and logs it loudly. Pure helpers, unit-tested in
 * tests/realtime-provider.test.ts.
 */
import { EndSensitivity, StartSensitivity } from '@google/genai';

export type RealtimeProvider = 'openai' | 'gemini' | 'xai';

type Env = Record<string, string | undefined>;

function asProvider(v: string | null | undefined): RealtimeProvider | null {
  const p = v?.trim().toLowerCase();
  return p === 'openai' || p === 'gemini' || p === 'xai' ? p : null;
}

/** Env override (staging) wins over the tenant setting; default OpenAI. */
export function resolveRealtimeProvider(
  configProvider?: string | null,
  env: Env = process.env,
): RealtimeProvider {
  return asProvider(env['REALTIME_PROVIDER']) ?? asProvider(configProvider) ?? 'openai';
}

const KEY_ENV: Record<RealtimeProvider, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  xai: 'XAI_API_KEY',
};

/**
 * A provider whose key is not configured can't take the call: fall back to
 * OpenAI rather than leave the caller in silence. `missingKey` names the
 * variable (never its value) for the loud log.
 */
export function withKeyFallback(
  provider: RealtimeProvider,
  env: Env = process.env,
): { provider: RealtimeProvider; missingKey: string | null } {
  if (provider === 'openai') return { provider, missingKey: null };
  const key = KEY_ENV[provider];
  return env[key]?.trim() ? { provider, missingKey: null } : { provider: 'openai', missingKey: key };
}

/**
 * Reasoning effort for OpenAI Realtime: 'low' (latency first) on
 * gpt-realtime-2.1*, an admin-only model. Nothing on gpt-realtime-2, so the
 * default tenants keep their exact current behaviour.
 */
export function openaiReasoning(model: string): { effort: 'low' } | undefined {
  return model.startsWith('gpt-realtime-2.1') ? { effort: 'low' } : undefined;
}

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.8-live';

/** Female voice by default: the tenant personas are written as a woman. */
export const DEFAULT_GEMINI_VOICE = 'Kore';

/** The 30 Gemini Live prebuilt voices (plugin api_proto Voice type). */
const GEMINI_VOICES = new Set([
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe',
  'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux',
  'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Pulcherrima', 'Puck',
  'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel',
  'Vindemiatrix', 'Zephyr', 'Zubenelgenubi',
]);

/**
 * Closest Gemini voice for the tenant's OpenAI voice, by Google's style label
 * (https://ai.google.dev/gemini-api/docs/speech-generation#voices). Gender is
 * preserved; the exact match is to confirm by ear in the listening test.
 * marin is the dashboard default; cedar and coral come next in its picker.
 */
export const OPENAI_TO_GEMINI_VOICE: Record<string, string> = {
  marin: 'Sulafat', // female, warm
  cedar: 'Achird', // male, friendly
  coral: 'Aoede', // female, breezy
};
/** Gender of the other OpenAI voices (same table as the web's VOICE_GENDER). */
const OPENAI_MALE_VOICES = new Set(['ballad', 'verse', 'alloy', 'echo', 'fable', 'onyx', 'ash']);
export const DEFAULT_GEMINI_MALE_VOICE = 'Charon';

const BCP47: Record<string, string> = { he: 'he-IL', fr: 'fr-FR', en: 'en-US' };

export interface GeminiLiveOptions {
  model: string;
  voice: string;
  language: string;
  apiKey?: string;
  instructions?: string;
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
  realtimeInputConfig: {
    automaticActivityDetection: {
      startOfSpeechSensitivity: StartSensitivity;
      endOfSpeechSensitivity: EndSensitivity;
      prefixPaddingMs: number;
      silenceDurationMs: number;
    };
  };
}

/**
 * Maps the tenant config to Gemini Live options.
 * - voice: tenant voices are OpenAI names (marin, cedar…), which Gemini does
 *   not have. A Gemini voice name is kept; GEMINI_VOICE overrides; otherwise
 *   OPENAI_TO_GEMINI_VOICE, then Kore (female) / Charon (male).
 * - language: BCP-47 hint from primaryLanguage. It only seeds the session:
 *   the prompt still tells the model to follow the caller's language.
 * - turn detection: closest to our OpenAI server_vad tuning (threshold 0.75,
 *   prefix 150 ms, silence 350 ms): low start sensitivity ignores short
 *   noises, high end sensitivity ends the turn sooner.
 * - no temperature (we don't send one to OpenAI either), no speed (Gemini
 *   Live has no speaking-rate setting).
 */
export function geminiLiveOptions(
  cfg: { voice?: string | null; primaryLanguage?: string | null },
  env: Env = process.env,
): GeminiLiveOptions {
  const tenantVoice = cfg.voice?.trim() ?? '';
  const override = env['GEMINI_VOICE']?.trim();
  const voice = GEMINI_VOICES.has(tenantVoice)
    ? tenantVoice
    : override
      ? override
      : OPENAI_TO_GEMINI_VOICE[tenantVoice] ??
        (OPENAI_MALE_VOICES.has(tenantVoice) ? DEFAULT_GEMINI_MALE_VOICE : DEFAULT_GEMINI_VOICE);
  const apiKey = env['GOOGLE_API_KEY']?.trim();
  return {
    model: env['GEMINI_LIVE_MODEL']?.trim() || DEFAULT_GEMINI_LIVE_MODEL,
    voice,
    language: BCP47[cfg.primaryLanguage ?? ''] ?? 'fr-FR',
    ...(apiKey ? { apiKey } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        prefixPaddingMs: 150,
        silenceDurationMs: 350,
      },
    },
  };
}

/**
 * Grok Voice 3.0, pinned: the plugin's default is the deprecated
 * grok-voice-think-fast-1.0. Doc: https://docs.x.ai/developers/model-capabilities/audio/voice-agent
 * (grok-voice-latest is an alias of grok-voice-3.0). Hebrew is not in xAI's
 * supported-language list: logged as a warning by the caller, not blocked.
 */
export const DEFAULT_GROK_VOICE_MODEL = 'grok-voice-3.0';

/** Closest Grok voice by gender (GET /v1/tts/voices gives the genders). */
export const OPENAI_TO_GROK_VOICE: Record<string, string> = {
  marin: 'eve', // female; xAI's documented default voice
  cedar: 'rex', // male
  coral: 'ara', // female
};
const GROK_VOICES = new Set([
  'altair', 'ara', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo',
  'eve', 'helios', 'helix', 'iris', 'kepler', 'leo', 'liora', 'lumen', 'luna',
  'lux', 'naksh', 'orion', 'perseus', 'rex', 'rigel', 'sal', 'sirius', 'ursa',
  'zagan', 'zenith',
]);

export function grokOptions(
  cfg: { voice?: string | null },
  env: Env = process.env,
): { model: string; voice: string; apiKey?: string } {
  const tenantVoice = cfg.voice?.trim().toLowerCase() ?? '';
  const override = env['GROK_VOICE']?.trim();
  const voice = GROK_VOICES.has(tenantVoice)
    ? tenantVoice
    : override
      ? override
      : OPENAI_TO_GROK_VOICE[tenantVoice] ?? (OPENAI_MALE_VOICES.has(tenantVoice) ? 'rex' : 'eve');
  const apiKey = env['XAI_API_KEY']?.trim();
  return {
    model: env['GROK_VOICE_MODEL']?.trim() || DEFAULT_GROK_VOICE_MODEL,
    voice,
    ...(apiKey ? { apiKey } : {}),
  };
}

/** xAI's voice agent doesn't list Hebrew (doc above): worth a warning. */
export function providerLanguageWarning(provider: RealtimeProvider, primaryLanguage?: string | null): string | null {
  return provider === 'xai' && primaryLanguage === 'he'
    ? 'Grok Voice does not list Hebrew as a supported language; quality may be poor'
    : null;
}
