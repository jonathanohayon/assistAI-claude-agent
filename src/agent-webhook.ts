import { createHmac } from 'node:crypto';

/**
 * Mode « agent webhook » (BYO-agent) — le cerveau vit chez le client.
 *
 * En mode normal, le modèle Realtime écoute ET répond. Ici il ne fait plus
 * que l'oreille et la voix : à chaque tour, on POSTe la transcription au
 * endpoint du client, et on fait prononcer le texte qu'il renvoie.
 *
 * Deux décisions structurantes :
 *
 * 1. Ce n'est PAS implémenté comme un tool Realtime. Le SDK laisse tomber un
 *    tool call quand le modèle combine audio de remplissage et appel d'outil
 *    (bug constaté en prod, cf. take_message retiré le 2026-05-13). L'appel
 *    réseau est donc découplé du flux vocal : on écoute l'événement de
 *    transcription, on appelle, on parle.
 *
 * 2. Le budget est ferme. Sur un appel, un silence est indistinguable d'une
 *    ligne coupée : on préfère prononcer une phrase d'attente à l'heure
 *    plutôt qu'une réponse parfaite trop tard.
 */

/** Fenêtre laissée à l'agent client. Au-delà, c'est du blanc à l'antenne. */
export const TURN_BUDGET_MS = 2000;

export interface AgentWebhookConfig {
  url: string;
  /** Secret HMAC. Sans lui la requête part non signée (le client ne peut pas vérifier). */
  secret?: string;
}

export interface WebhookTurn {
  role: 'user' | 'agent';
  text: string;
}

/** Phrases de repli, par langue — jamais de silence. */
const STALL: Record<string, string> = {
  fr: 'Un instant, je vérifie.',
  he: 'רגע אחד, אני בודקת.',
  en: 'One moment, let me check.',
};

export function stallLine(language: string): string {
  return STALL[language] ?? STALL['en']!;
}

export interface WebhookResult {
  reply: string | null;
  elapsedMs: number;
  /** Pourquoi on n'a pas de réponse — pour les logs, pas pour l'appelant. */
  failure?: 'timeout' | 'http' | 'shape' | 'network';
  status?: number;
}

/**
 * Appelle l'agent du client pour un tour de parole.
 *
 * Ne throw jamais : un échec renvoie `reply: null` et l'appelant décide quoi
 * prononcer. Couper l'appel parce que le endpoint du client est tombé serait
 * la pire réaction possible.
 */
export async function callAgentWebhook(
  config: AgentWebhookConfig,
  params: {
    callId: string;
    turnId: number;
    language: string;
    transcript: string;
    history: WebhookTurn[];
  },
): Promise<WebhookResult> {
  const body = JSON.stringify({
    call_id: params.callId,
    turn_id: params.turnId,
    language: params.language,
    transcript: params.transcript,
    // Fenêtre glissante : l'historique complet d'un appel long ferait grossir
    // la charge utile à chaque tour, au détriment du budget.
    history: params.history.slice(-12),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Tamara-Voice/1.0',
  };
  if (config.secret) {
    headers['X-Tamara-Signature'] = createHmac('sha256', config.secret)
      .update(body)
      .digest('hex');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_BUDGET_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      return { reply: null, elapsedMs, failure: 'http', status: res.status };
    }

    const raw = await res.text();
    let reply: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { reply?: unknown };
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
        reply = parsed.reply.trim();
      }
    } catch {
      // Corps non-JSON → traité comme une réponse mal formée.
    }

    if (!reply) {
      return { reply: null, elapsedMs, failure: 'shape', status: res.status };
    }
    return { reply, elapsedMs, status: res.status };
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    const aborted = (e as Error)?.name === 'AbortError';
    return { reply: null, elapsedMs, failure: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
