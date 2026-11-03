/**
 * Which speech-to-speech model answers the phone.
 *
 * REALTIME_PROVIDER = 'openai' (default) | 'gemini'. Production does not set it,
 * so it keeps OpenAI Realtime with no behaviour change; the Gemini Live POC
 * runs on worker-staging only. Pure helpers, unit-tested in
 * tests/realtime-provider.test.ts.
 */
import { EndSensitivity, StartSensitivity } from '@google/genai';

export type RealtimeProvider = 'openai' | 'gemini';

type Env = Record<string, string | undefined>;

export function resolveRealtimeProvider(env: Env = process.env): RealtimeProvider {
  return env['REALTIME_PROVIDER']?.trim().toLowerCase() === 'gemini' ? 'gemini' : 'openai';
}

/**
 * gemini-3.8-live: the newest native-audio Live model, available on both the
 * Gemini API (API key, what we use) and Vertex AI (an EU region later, for
 * latency). The plugin's own Gemini-API default is still a 2.5 preview.
 */
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
