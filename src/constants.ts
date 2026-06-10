/**
 * Constantes runtime du worker. Toutes les valeurs "magic numbers" qui
 * pilotent les timings, seuils, hard-caps. Centralisé pour faciliter le
 * tuning sans chercher dans tout le code.
 *
 * Convention : tout est en millisecondes. Les valeurs surchargeables via
 * env var sont notées en commentaire.
 */

/**
 * Inactivity threshold before the agent hangs up by itself.
 * 30s = enough for a customer to think mid-conversation without us cutting
 * them off, but short enough that a stale call doesn't linger forever.
 * Override via `SILENCE_HANGUP_MS` env var.
 */
export const SILENCE_HANGUP_MS = Number(
  process.env['SILENCE_HANGUP_MS'] ?? 30_000,
);

/**
 * Durée maximale absolue d'un appel avant raccroché forcé.
 * 30 minutes par défaut — aucun appel légitime ne dure aussi longtemps ;
 * au-delà c'est presque toujours une ligne zombie (SIP pas raccroché,
 * boucle LLM, etc.) qui facture du Twilio + OpenAI pour rien.
 * Override via `MAX_CALL_DURATION_MS` env var.
 */
export const MAX_CALL_DURATION_MS = Number(
  process.env['MAX_CALL_DURATION_MS'] ?? 30 * 60_000,
);

/**
 * Hard-cap delay between an LLM-triggered end_call and the actual close.
 * On attend normalement la transition speaking → idle/listening (= goodbye
 * audio fini). Ce hard-cap est un safety net si l'event ne fire jamais
 * (tool call sans speech, stuck state, etc.).
 */
export const END_CALL_HARD_CAP_MS = 8_000;

/**
 * Min hold après que le goodbye finit de streamer. Le temps que les
 * dernières frames audio sortent du buffer RTP SIP vers l'appelant.
 */
export const END_CALL_TRAILING_MS = 600;

/**
 * Grace period en début d'appel avant que le silence watchdog ne commence
 * à compter. Le client peut faire une courte pause après le greeting,
 * inutile de raccrocher dessus.
 */
export const SILENCE_GRACE_START_MS = 10_000;

/**
 * Timeout du fetch `/api/agent/config` au début de chaque appel.
 * Au-delà : on tombe sur le fallback hardcoded (defaultConfig()).
 */
export const CONFIG_FETCH_TIMEOUT_MS = 5_000;

/**
 * Timeout du POST `/api/calls/end` (recap WhatsApp/email post-appel).
 * Le summary LLM peut prendre du temps → on est généreux.
 */
export const POST_CALL_TIMEOUT_MS = 30_000;

/**
 * Timeout du POST `/api/events` (log distant best-effort).
 * Court car non-bloquant pour la session.
 */
export const REMOTE_LOG_TIMEOUT_MS = 5_000;

/**
 * Combien de temps attendre les attributes SIP / metadata Web après
 * `ctx.connect()` avant de fallback sur origin "unknown".
 */
export const ORIGIN_DETECTION_TIMEOUT_MS = 1_500;

/**
 * Valeur par défaut du slider noise reduction (1-10) si /api/agent/config
 * ne retourne pas le champ (DB pas migrée ou ancien deploy web).
 * 8 = enhancementLevel 0.8 du QVF (équilibré, recommandé téléphonie).
 */
export const DEFAULT_NOISE_REDUCTION_LEVEL = 8;
