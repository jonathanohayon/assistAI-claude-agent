/**
 * Récupère la config tenant depuis `/api/agent/config` côté web.
 *
 * Le routing tenant dépend de l'origine de la session :
 *   - SIP Twilio  → `?phone=<numéro composé>` → tenant via phone_numbers
 *   - Web LiveTest → `?userId=<auth.user.id>` → tenant direct
 *   - Unknown      → pas de query param → fallback resolveDefaultTenant
 *
 * Failure-open : si l'API est down ou retourne une erreur, on retombe sur
 * `defaultConfig()` (depuis `./config.js` legacy) pour ne pas planter
 * l'appel. Le tenant verra un comportement par défaut au lieu d'un crash.
 */

import {
  GREETING_INSTRUCTIONS as FALLBACK_GREETING,
  INSTRUCTIONS as FALLBACK_INSTRUCTIONS,
  REALTIME_CONFIG,
} from '../config.js';

import {
  CONFIG_FETCH_TIMEOUT_MS,
  DEFAULT_NOISE_REDUCTION_LEVEL,
} from './constants.js';
import type {
  AgentFeatures,
  FetchedConfig,
  SessionOrigin,
} from './types.js';

/**
 * Permissif par défaut — si le fetch échoue ou si l'admin n'a pas encore
 * configuré la matrice plan_features, le tenant garde toutes les
 * capacités au lieu de se retrouver muet (failure-open).
 *
 * C'est volontaire : un trial qui perd silencieusement ses tools serait
 * dur à diagnostiquer (l'utilisateur appelle, l'agent ne sait pas faire
 * de RDV, mais aucune erreur explicite). Mieux vaut tout ouvrir et
 * laisser le tenant désactiver explicitement via /admin si besoin.
 */
export const DEFAULT_FEATURES: AgentFeatures = {
  calendar: true,
  crm: true,
  whatsapp_confirm: true,
  whatsapp_recap: true,
};

/**
 * Config par défaut utilisée quand `/api/agent/config` est injoignable
 * ou retourne une erreur HTTP. Reprend les constantes hardcodées du
 * `config.ts` legacy (persona "Tamara/Prestige" historique).
 */
export function defaultConfig(): FetchedConfig {
  return {
    instructions: FALLBACK_INSTRUCTIONS,
    greetingInstructions: FALLBACK_GREETING,
    agentName: '',
    model: REALTIME_CONFIG.model,
    voice: REALTIME_CONFIG.voice,
    temperature: REALTIME_CONFIG.temperature,
    speed: REALTIME_CONFIG.speed,
    maxResponseTokens: 220,
    noiseReductionLevel: DEFAULT_NOISE_REDUCTION_LEVEL,
    greetingFallbackTemplate: '',
    features: DEFAULT_FEATURES,
  };
}

/**
 * Fetch la config tenant en routing selon l'origine de la session.
 *
 * Timeout strict (5s par défaut). En cas d'échec à n'importe quel niveau
 * (network, parse, HTTP error) → fallback sur `defaultConfig()` + warn
 * console.
 */
export async function fetchConfig(
  origin: SessionOrigin,
): Promise<FetchedConfig> {
  const appUrl = process.env['APP_URL'];
  if (!appUrl) {
    console.warn('[config] APP_URL not set, using compiled defaults');
    return defaultConfig();
  }

  // Appel sortant de campagne : endpoint dédié (instructions bâties depuis
  // l'objectif/persona + variables du contact), gardé par x-internal-secret.
  const headers: Record<string, string> = {};
  if (origin.kind === 'campaign' || origin.kind === 'outbound_test') {
    const secret = process.env['INTERNAL_SECRET'];
    if (secret) headers['x-internal-secret'] = secret;
  }

  try {
    const url =
      origin.kind === 'sip'
        ? `${appUrl}/api/agent/config?phone=${encodeURIComponent(origin.calledNumber)}`
        : origin.kind === 'web'
          ? `${appUrl}/api/agent/config?userId=${encodeURIComponent(origin.userId)}`
          : origin.kind === 'campaign'
            ? `${appUrl}/api/agent/campaign-config?campaignId=${encodeURIComponent(origin.campaignId)}&contactId=${encodeURIComponent(origin.contactId)}`
            : origin.kind === 'outbound_test'
              ? `${appUrl}/api/agent/outbound-test-config?agentId=${encodeURIComponent(origin.agentId)}`
              : `${appUrl}/api/agent/config`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(
        `[config] /api/agent/config → ${res.status}, using defaults`,
      );
      return defaultConfig();
    }
    const data = (await res.json()) as Partial<FetchedConfig>;

    return {
      instructions: data.instructions ?? FALLBACK_INSTRUCTIONS,
      greetingInstructions: data.greetingInstructions ?? FALLBACK_GREETING,
      agentName: typeof data.agentName === 'string' ? data.agentName : '',
      model: data.model ?? REALTIME_CONFIG.model,
      voice: data.voice ?? REALTIME_CONFIG.voice,
      temperature: data.temperature ?? REALTIME_CONFIG.temperature,
      speed: data.speed ?? REALTIME_CONFIG.speed,
      maxResponseTokens: data.maxResponseTokens ?? 220,
      greetingFallbackTemplate:
        typeof data.greetingFallbackTemplate === 'string'
          ? data.greetingFallbackTemplate
          : '',
      // Slider 1-10. Si /api/agent/config n'a pas encore le champ (DB
      // pas migrée ou ancien deploy), fallback sur DEFAULT_NOISE_REDUCTION_LEVEL.
      noiseReductionLevel:
        typeof data.noiseReductionLevel === 'number'
          ? Math.min(
              10,
              Math.max(1, Math.round(data.noiseReductionLevel)),
            )
          : DEFAULT_NOISE_REDUCTION_LEVEL,
      // Si le web n'a pas (encore) déployé le champ features, on ouvre
      // tout par défaut (mode legacy = plan premium implicite).
      features: data.features ?? DEFAULT_FEATURES,
      // exactOptionalPropertyTypes refuse 'undefined' explicite ; on
      // omet la clé si vide pour ne pas planter le typing.
      ...(data.perCallContextTemplate !== undefined
        ? { perCallContextTemplate: data.perCallContextTemplate }
        : {}),
    };
  } catch (e) {
    console.warn(
      `[config] fetch failed (${(e as Error).message}), using defaults`,
    );
    return defaultConfig();
  }
}
