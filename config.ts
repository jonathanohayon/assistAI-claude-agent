// Realtime model defaults and the LiveKit dispatch name. No persona here:
// every persona comes from the tenant's config (/api/agent/config); the
// fallback when it can't be loaded is neutral (src/fallback-persona.ts).

export const REALTIME_CONFIG = {
  // 'gpt-realtime' (sans suffixe) n'existe PAS dans le catalog OpenAI — utilisé
  // jusqu'au 12/05/26, ça crashait la session dès que /api/agent/config était
  // injoignable (worker → fallback defaultConfig → ce modèle inexistant →
  // model_not_found unhandled error → no voice).
  // Modèles dispo confirmés via /v1/models : gpt-realtime-2 (latest premium),
  // gpt-realtime-mini (low-cost), gpt-realtime-1.5.
  model: process.env['REALTIME_MODEL'] ?? 'gpt-realtime-2',
  voice: process.env['REALTIME_VOICE'] ?? 'marin',
  // gpt-realtime-whisper : modèle de transcription dédié au Realtime API
  // (meilleur multilingue HE/FR/EN que whisper-1, tuned pour faible latence
  // streaming). Override par REALTIME_TRANSCRIPTION_MODEL si OpenAI rename.
  transcriptionModel:
    process.env['REALTIME_TRANSCRIPTION_MODEL'] ?? 'gpt-realtime-whisper',
  apiBase: process.env['REALTIME_API_BASE'] ?? 'https://api.openai.com/v1',

  // 100% vocal — pas de canal texte côté sortie modèle
  modalities: ['audio'] as const,

  // Vitesse de parole (1.0 = naturel, 1.2 = un peu plus rapide pour latence)
  speed: 1.0,
} as const;
// Note : la longueur de réponse est contrôlée via le prompt du tenant (le SDK
// TS n'expose pas maxResponseOutputTokens publiquement).

// LiveKit dispatch name. Production inbound SIP is dispatched to
// 'appointment-agent'. A test worker (e.g. an SDK upgrade under test) MUST set
// AGENT_NAME to something else, otherwise it registers under the production
// name and LiveKit can hand it real customer calls.
export const AGENT_NAME = 'appointment-agent';

/** Read at registration time (after dotenv), not at import time. */
export function resolveAgentName(env: NodeJS.ProcessEnv = process.env): string {
  return env['AGENT_NAME']?.trim() || AGENT_NAME;
}
