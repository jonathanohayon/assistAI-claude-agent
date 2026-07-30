/**
 * Config d'agent servie par Tamara (tamaravox).
 *
 * Inversion de responsabilité : jusqu'ici la voix était choisie dans le
 * système du tenant. Or un agent est un cerveau texte — il arrive sans voix.
 * Le choix appartient donc à la couche vocale, et c'est ici qu'on va le
 * chercher.
 *
 * Le routage se fait par numéro appelé, seule information dont on dispose au
 * décrochage. Un 404 est le cas courant, pas une panne : le numéro appartient
 * alors à un autre système et l'appelant poursuit son chemin habituel.
 */

import { CONFIG_FETCH_TIMEOUT_MS } from './constants.js';

export interface VoxAgentConfig {
  id: string;
  name: string;
  agentWebhook: { url: string; secret?: string };
  voice: string;
  primaryLanguage: string;
  languages: string[];
  /** Multiplicateur de débit, 0.5–1.5. */
  speed: number;
  /** Consigne de diction — comment parler, pas quoi dire. */
  deliveryStyle: string;
}

/**
 * Cherche l'agent Tamara correspondant au numéro appelé.
 *
 * Ne throw jamais et renvoie null à la moindre incertitude : un incident côté
 * Tamara doit dégrader vers le comportement historique, jamais couper l'appel.
 */
export async function fetchVoxConfigByPhone(
  calledNumber: string,
): Promise<VoxAgentConfig | null> {
  const base = process.env['TAMARAVOX_URL'];
  const secret = process.env['TAMARAVOX_WORKER_SECRET'];
  if (!base || !secret) return null;

  const url = `${base.replace(/\/$/, '')}/api/v1/agent-config/by-phone?phone=${encodeURIComponent(calledNumber)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { 'x-worker-secret': secret },
      signal: controller.signal,
    });
    // 404 = numéro inconnu de Tamara. Normal, et silencieux.
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[vox_config] ${res.status} pour ${calledNumber}`);
      return null;
    }

    const data = (await res.json()) as Partial<VoxAgentConfig>;
    if (!data?.agentWebhook?.url) {
      console.warn('[vox_config] réponse sans webhook exploitable');
      return null;
    }

    return {
      id: String(data.id ?? ''),
      name: String(data.name ?? ''),
      agentWebhook: data.agentWebhook,
      voice: typeof data.voice === 'string' ? data.voice : 'marin',
      primaryLanguage:
        data.primaryLanguage === 'fr' || data.primaryLanguage === 'he'
          ? data.primaryLanguage
          : 'en',
      languages: Array.isArray(data.languages) ? data.languages : ['en'],
      // Borné : une valeur aberrante rendrait la voix inaudible.
      speed:
        typeof data.speed === 'number'
          ? Math.min(1.5, Math.max(0.5, data.speed))
          : 1,
      deliveryStyle:
        typeof data.deliveryStyle === 'string' ? data.deliveryStyle : '',
    };
  } catch (e) {
    console.warn(`[vox_config] échec (${(e as Error).message})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Instructions minimales pour un agent Tamara.
 *
 * En mode BYO le modèle ne décide de rien : il prononce ce que le webhook
 * renvoie. Ces instructions ne portent donc que la diction. Y laisser une
 * persona ferait improviser le modèle par-dessus les mots du client.
 */
export function voxInstructions(cfg: VoxAgentConfig): string {
  const langNames: Record<string, string> = {
    en: 'anglais',
    fr: 'français',
    he: 'hébreu',
  };
  const spoken = cfg.languages
    .map((l) => langNames[l] ?? l)
    .join(', ');

  return [
    `Tu es la voix d'un agent téléphonique. Tu ne décides jamais du contenu :`,
    `tu prononces exactement le texte qu'on te donne.`,
    ``,
    `Langue d'accueil : ${langNames[cfg.primaryLanguage] ?? cfg.primaryLanguage}.`,
    `Langues parlées : ${spoken}. Suis la langue de ton interlocuteur.`,
    cfg.deliveryStyle ? `` : null,
    cfg.deliveryStyle ? `Diction : ${cfg.deliveryStyle}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Rapporte un tour de parole à Tamara, pour le monitoring.
 *
 * Fire-and-forget et silencieux : journaliser ne doit jamais peser sur un
 * appel en cours, ni le faire échouer si Tamara est indisponible.
 */
export function reportTurn(payload: {
  agentId: string;
  callId: string;
  turnId: number;
  elapsedMs: number;
  ok: boolean;
  failure?: string;
  status?: number;
  language?: string;
  transcript?: string;
  reply?: string;
}): void {
  const base = process.env['TAMARAVOX_URL'];
  const secret = process.env['TAMARAVOX_WORKER_SECRET'];
  if (!base || !secret || !payload.agentId) return;

  void fetch(`${base.replace(/\/$/, '')}/api/v1/turns`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': secret,
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    /* le monitoring ne casse jamais un appel */
  });
}
