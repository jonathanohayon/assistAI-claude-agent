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
import {
  ConfigRefusedError,
  configFallbackLog,
  refusalFromResponse,
} from './config-refusal.js';
import { fetchVoxConfigByPhone, voxInstructions } from './vox-config.js';
import { webGet } from './web-api.js';

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
  // ── Tamara d'abord, pour les numéros qui lui appartiennent ───────────
  // La voix se règle désormais côté Tamara : un agent est un cerveau texte et
  // arrive sans voix. On interroge donc Tamara AVANT le tenant, et on ne
  // retombe sur le chemin historique que si le numéro lui est inconnu — ce
  // qui reste le cas de la majorité des appels.
  if (origin.kind === 'sip') {
    const vox = await fetchVoxConfigByPhone(origin.calledNumber);
    if (vox) {
      console.log(
        `[config] agent Tamara « ${vox.name} » (${vox.id}) pour ${origin.calledNumber}`,
      );
      return {
        // Le modèle ne porte plus de persona : il prononce ce que le webhook
        // renvoie, avec la diction demandée.
        instructions: voxInstructions(vox),
        greetingInstructions: '',
        agentName: vox.name,
        model: REALTIME_CONFIG.model,
        voice: vox.voice,
        speed: vox.speed,
        maxResponseTokens: 220,
        noiseReductionLevel: DEFAULT_NOISE_REDUCTION_LEVEL,
        greetingFallbackTemplate: '',
        // Un agent Tamara n'utilise aucun tool du tenant : son cerveau est
        // ailleurs et ne connaît ni notre agenda ni notre CRM.
        features: {
          calendar: false,
          crm: false,
          whatsapp_confirm: false,
          whatsapp_recap: false,
        },
        primaryLanguage: vox.primaryLanguage,
        agentWebhook: vox.agentWebhook,
        voxAgentId: vox.id,
      };
    }
  }

  if (!process.env['APP_URL']) {
    console.warn('[config] APP_URL not set, using compiled defaults');
    return defaultConfig();
  }

  try {
    // Endpoint par origine. campaign/outbound_test ont un endpoint dédié
    // (instructions bâties depuis l'objectif/persona + variables du contact).
    // Le header x-internal-secret est posé par webGet pour tous.
    const path =
      origin.kind === 'sip'
        ? `/api/agent/config?phone=${encodeURIComponent(origin.calledNumber)}`
        : origin.kind === 'web'
          ? `/api/agent/config?userId=${encodeURIComponent(origin.userId)}`
          : origin.kind === 'campaign'
            ? `/api/agent/campaign-config?campaignId=${encodeURIComponent(origin.campaignId)}&contactId=${encodeURIComponent(origin.contactId)}`
            : origin.kind === 'outbound_test'
              ? `/api/agent/outbound-test-config?agentId=${encodeURIComponent(origin.agentId)}`
              : `/api/agent/config`;

    const res = await webGet(path, { timeoutMs: CONFIG_FETCH_TIMEOUT_MS });
    if (!res.ok) {
      const refusal = refusalFromResponse(
        res.status,
        await res.json().catch(() => null),
      );
      if (refusal) throw new ConfigRefusedError(refusal);
      const log = configFallbackLog(res.status, path);
      if (log.level === 'error') console.error(log.message);
      else console.warn(log.message);
      return defaultConfig();
    }
    const data = (await res.json()) as Partial<FetchedConfig>;

    return {
      instructions: data.instructions ?? FALLBACK_INSTRUCTIONS,
      greetingInstructions: data.greetingInstructions ?? FALLBACK_GREETING,
      agentName: typeof data.agentName === 'string' ? data.agentName : '',
      realtimeProvider:
        data.realtimeProvider === 'gemini' || data.realtimeProvider === 'xai'
          ? data.realtimeProvider
          : 'openai',
      model: data.model ?? REALTIME_CONFIG.model,
      voice: data.voice ?? REALTIME_CONFIG.voice,
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
      // Prise de commandes : opt-in, false si absent (ancien deploy web).
      ordersEnabled: data.ordersEnabled === true,
      // BYO-agent : uniquement si le web renvoie une URL exploitable. Une
      // valeur douteuse doit laisser le tenant en mode persona plutôt que
      // de router les tours vers le vide.
      ...(typeof data.agentWebhook?.url === 'string' &&
      data.agentWebhook.url.startsWith('http')
        ? { agentWebhook: data.agentWebhook }
        : {}),
      // exactOptionalPropertyTypes refuse 'undefined' explicite ; on
      // omet la clé si vide pour ne pas planter le typing.
      ...(data.perCallContextTemplate !== undefined
        ? { perCallContextTemplate: data.perCallContextTemplate }
        : {}),
    };
  } catch (e) {
    if (e instanceof ConfigRefusedError) throw e;
    console.warn(
      `[config] fetch failed (${(e as Error).message}), using defaults`,
    );
    return defaultConfig();
  }
}
