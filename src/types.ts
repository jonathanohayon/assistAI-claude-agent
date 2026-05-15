/**
 * Types et interfaces partagées entre les modules du worker.
 *
 * À séparer en fichiers dédiés si le fichier dépasse ~150 lignes.
 */

/**
 * UserData attaché au JobContext LiveKit. On ne stocke rien actuellement
 * (Silero VAD retiré qui était la seule donnée portée). Le type générique
 * est conservé au cas où on en rajoute (state inter-tours partagé, etc.).
 */
export type ProcessUserData = Record<string, never>;

/**
 * Map plan × feature renvoyée par `/api/agent/config` (cf. lib/plan-features
 * côté web). Toutes les clés sont optionnelles ; on lit défensivement avec
 * `?? false` côté code worker pour éviter les "feature drop silencieux".
 */
export interface AgentFeatures {
  calendar?: boolean;
  crm?: boolean;
  whatsapp_confirm?: boolean;
  whatsapp_recap?: boolean;
}

/**
 * Config tenant complète résolue par /api/agent/config. Le payload fusionne :
 *   - agent_configs (DB per-tenant)  : persona, voix, modèle, etc.
 *   - app_settings (admin per-plan)  : directives système, fallbacks
 *   - plan_features (admin matrix)   : tools autorisés
 */
export interface FetchedConfig {
  /** System prompt assemblé (persona + admin blocks + language directive). */
  instructions: string;
  /** Phrase exacte à prononcer à l'ouverture, ou "" pour laisser le persona décider. */
  greetingInstructions: string;
  /**
   * Prénom de l'agent (facultatif, `agent_name` DB). Utilisé par le
   * fallback greeting pour éviter qu'un persona sans nom de centre
   * pousse le LLM à halluciner un nom fictif.
   */
  agentName: string;
  /**
   * Template per-plan injecté quand `greetingInstructions` est vide.
   * Édité depuis `/admin` par l'admin. Placeholders : `{agent_name}`.
   * Si vide ET pas de greetingInstructions → pas d'override, persona seul.
   */
  greetingFallbackTemplate: string;
  /** Modèle OpenAI Realtime (ex. "gpt-realtime-2"). */
  model: string;
  /** Voix Realtime (ex. "marin", "coral"). */
  voice: string;
  /** Température 0.0-1.5 (envoyée via session.update à chaud). */
  temperature: number;
  /** Vitesse de lecture 0.5-1.5 (passée au constructor du model). */
  speed: number;
  /** Max output tokens — pas utilisé en prod (cap a cassé des greetings). */
  maxResponseTokens: number;
  /** Features actives pour ce plan. */
  features: AgentFeatures;
  /**
   * Slider 1-10 piloté depuis `/dashboard`. Mappé vers `enhancementLevel`
   * 0.1-1.0 du QVF 2.1 L à la création de la session.
   */
  noiseReductionLevel: number;
  /**
   * Template injecté en chatCtx au début de chaque appel. Contient des
   * placeholders runtime : `{date_fr}`, `{iso_date}`, `{time}`,
   * `{caller_hint_block}`. Édité depuis `/admin`. Vide → fallback ci-bas.
   */
  perCallContextTemplate?: string;
}

/**
 * Un tour de conversation (user ou assistant). Stocké dans le tableau
 * `transcript[]` du worker, puis POSTé à `/api/calls/end` à la fin.
 */
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Source de la session — déterminée au début de l'appel via
 * `detectOrigin()`. Conditionne la résolution du tenant côté
 * /api/agent/config (?phone vs ?userId vs default).
 *
 *   - `sip`     : appel Twilio entrant, on lit `sip.trunkPhoneNumber`
 *   - `web`     : LiveTest depuis le navigateur (Phase 2), userId via metadata
 *   - `unknown` : ni l'un ni l'autre — fallback default tenant
 */
export type SessionOrigin =
  | { kind: 'sip'; calledNumber: string }
  | { kind: 'web'; userId: string }
  | { kind: 'unknown' };
