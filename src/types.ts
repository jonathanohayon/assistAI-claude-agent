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
   * Speech-to-speech engine chosen by an admin for this tenant ('openai'
   * when unset or when the web predates the field). See src/realtime-provider.
   */
  realtimeProvider?: 'openai' | 'gemini' | 'xai';
  /** Voice profile from the web (admin-only); resolved by src/voice-profile. */
  voiceProfile?: unknown;
  /** Loyalty v1: caller's visit history with this tenant (null = unknown). See src/client-profile. */
  clientProfile?: import('./client-profile.js').ClientProfile | null;
  /** Per-tenant call-transfer number (E.164, '' = none), web #152. */
  transferNumber?: string;
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
  /** Vitesse de lecture 0.5-1.5 (passée au constructor du model). */
  speed: number;
  /** Max output tokens — pas utilisé en prod (cap a cassé des greetings). */
  maxResponseTokens: number;
  /** Features actives pour ce plan. */
  features: AgentFeatures;
  /**
   * Mode BYO-agent : si présent, le cerveau vit chez le client. Le modèle
   * Realtime ne fait plus qu'écouter et parler, et chaque tour part vers ce
   * endpoint. Absent = comportement historique (le modèle répond lui-même).
   */
  agentWebhook?: { url: string; secret?: string };
  /** Identifiant de l'agent Tamara, pour rattacher les tours au monitoring. */
  voxAgentId?: string;
  /**
   * Prise de commandes au téléphone activée (toggle "Commandes" de la tuile
   * CRM). Quand vrai, le worker enregistre le tool `record_order`. Défaut
   * false (opt-in). Absent du payload web ancien → traité comme false.
   */
  ordersEnabled?: boolean;
  /**
   * Slider 1-10 piloté depuis `/dashboard`. Mappé vers `enhancementLevel`
   * 0.1-1.0 du QVF 2.1 L à la création de la session.
   */
  noiseReductionLevel: number;
  /** Langue d'accueil (he/fr/en). Aussi utilisée comme language hint
   *  pour le STT input_audio_transcription. */
  primaryLanguage?: 'he' | 'fr' | 'en' | string;
  /**
   * Template injecté en chatCtx au début de chaque appel. Contient des
   * placeholders runtime : `{date_fr}`, `{iso_date}`, `{time}`,
   * `{caller_hint_block}`. Édité depuis `/admin`. Vide → fallback ci-bas.
   */
  perCallContextTemplate?: string;
  /**
   * Données business structurées du tenant : identité + centres (avec
   * horaires hebdo) + soins/tarifs. Exposé via 5 tools fixes côté worker
   * (list_centres, get_centre_info, get_opening_hours, list_services,
   * find_service) — voir `tools/business.ts`.
   */
  business?: BusinessConfig;
}

export type BusinessWeekDay =
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat'
  | 'sun';

export interface BusinessConfig {
  identity: { name: string; tagline: string; email: string };
  centres: Array<{
    id: string;
    name: string;
    address: string;
    hours: Record<
      BusinessWeekDay,
      { open: boolean; openTime: string; closeTime: string }
    >;
  }>;
  services: Array<{
    id: string;
    name: string;
    durationMinutes: number;
    priceILS: number;
    centreIds: string[] | 'all';
    description: string;
  }>;
  /** Texte libre optionnel — règles strictes centres/jours injectées dans
   *  le system prompt sous "Centers and Days Rules (STRICT)". */
  centresRules?: string;
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
 *   - `sip`     : appel Twilio entrant, on lit `sip.trunkPhoneNumber`.
 *                 `channel` distingue PSTN (Twilio classique) et WhatsApp
 *                 (même chemin SIP, mais numéro composé préfixé `whatsapp:`).
 *                 `calledNumber` est toujours le numéro nu (préfixe retiré).
 *   - `web`     : LiveTest depuis le navigateur (Phase 2), userId via metadata
 *   - `unknown` : ni l'un ni l'autre — fallback default tenant
 */
export type CallChannel = 'pstn' | 'whatsapp';

export type SessionOrigin =
  | { kind: 'sip'; calledNumber: string; channel: CallChannel }
  | { kind: 'web'; userId: string }
  // Appel SORTANT de campagne — la metadata de dispatch porte
  // { source:'campaign', campaignId, contactId, userId }. La config runtime
  // vient de /api/agent/campaign-config et le recap part vers
  // /api/agent/campaign-result.
  | { kind: 'campaign'; campaignId: string; contactId: string; userId: string }
  // Test LIVE d'un agent sortant depuis le dashboard (navigateur). La metadata
  // de dispatch porte { source:'outbound_test', agentId, userId }. La config
  // vient de /api/agent/outbound-test-config (voix/persona/connaissance de
  // l'agent). Aucun recap (c'est un test).
  | { kind: 'outbound_test'; agentId: string; userId: string }
  | { kind: 'unknown' };
