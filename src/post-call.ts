/**
 * Hook post-appel — POST le transcript final à `/api/calls/end` côté web.
 *
 * Le web service prend le relais :
 *   1. Génère un summary LLM (cf. lib/summarize.ts) avec le ton du plan
 *   2. Envoie un WhatsApp client (recap rendez-vous) si numéro disponible
 *   3. Envoie un WhatsApp owner (recap proprio) si owner_whatsapp set
 *   4. Persiste l'appel en DB pour audit + dashboard logs
 *
 * Best-effort : la fonction ne throw JAMAIS. Mais contrairement à la
 * télémétrie, un échec ici = PERTE DE DONNÉES (le transcript n'existe
 * nulle part ailleurs). Donc :
 *   - retry avec backoff (3 tentatives : immédiat, +1s, +4s)
 *   - en dernier recours, le payload COMPLET est dumpé en console.error
 *     pour recovery manuelle depuis les logs Railway.
 */

import { POST_CALL_TIMEOUT_MS } from './constants.js';
import type { CallChannel, TranscriptEntry } from './types.js';
import { currentCallId } from './session-context.js';
import { webPost } from './web-api.js';

/** Délais avant chaque tentative : immédiat, +1s, +4s. */
const RETRY_DELAYS_MS = [0, 1_000, 4_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST avec retry/backoff vers l'app web. Retente quand le fetch throw
 * (réseau, timeout) OU quand le web répond 5xx (erreur transitoire). Un
 * 4xx n'est PAS retenté (payload invalide — rejouer ne changera rien).
 *
 * @returns la Response finale (status < 500), ou null si les 3 tentatives
 *          ont échoué. Ne throw jamais.
 */
async function fetchWithRetry(
  label: string,
  path: string,
  payload: unknown,
): Promise<Response | null> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const delay = RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) await sleep(delay);
    try {
      const res = await webPost(path, payload, {
        timeoutMs: POST_CALL_TIMEOUT_MS,
      });
      if (res.status < 500) return res;
      console.warn(
        `${label} ${path} → HTTP ${res.status} (tentative ${attempt + 1}/${RETRY_DELAYS_MS.length})`,
      );
    } catch (e) {
      console.warn(
        `${label} ${path} failed (tentative ${attempt + 1}/${RETRY_DELAYS_MS.length}): ${(e as Error).message}`,
      );
    }
  }
  return null;
}

/**
 * POST le résultat d'un appel de campagne SORTANTE à
 * `/api/agent/campaign-result`. Le web prend le relais (analyse IA : résumé
 * + disposition + sentiment + extraction, transition du contact, retry,
 * auto-complétion). Best-effort : ne throw jamais.
 *
 * `outcome` est dérivé du transcript : non-vide → 'connected' (l'agent a
 * parlé avec quelqu'un), vide → 'no_answer'. Les autres issues (busy,
 * voicemail, failed) sont mieux détectées au niveau dialing si dispo ;
 * ici on couvre le cas nominal.
 */
export async function postCampaignResult(
  campaignId: string,
  contactId: string,
  transcript: TranscriptEntry[],
  durationSeconds: number,
): Promise<void> {
  const appUrl = process.env['APP_URL'];
  const secret = process.env['INTERNAL_SECRET'];
  if (!appUrl || !secret) {
    console.warn('[campaign] APP_URL or INTERNAL_SECRET missing — skipping result');
    return;
  }
  const outcome = transcript.length > 0 ? 'connected' : 'no_answer';
  const payload = {
    campaignId,
    contactId,
    outcome,
    transcript,
    durationSeconds,
  };
  const res = await fetchWithRetry(
    '[campaign]',
    '/api/agent/campaign-result',
    payload,
  );
  if (!res) {
    console.error(
      '[post-call] PERTE DE DONNÉES — payload pour recovery manuelle:',
      JSON.stringify(payload),
    );
    return;
  }
  const body = await res.text().catch(() => '');
  console.log(`[campaign] /api/agent/campaign-result → ${res.status} ${body.slice(0, 160)}`);
}

/** Optional call-end fields; each key is sent only when defined. */
export interface CallEndExtras {
  /** See src/client-agent-reach.ts. undefined → key omitted. */
  clientAgentReached?: boolean;
  /** Opaque token served on connector routes only, echoed unchanged. undefined → key omitted. */
  connectorRoute?: string;
}

/** The /api/calls/end body. Pure, so the exact JSON can be pinned in tests. */
export function buildCallEndPayload(p: {
  callId: string | undefined;
  transcript: TranscriptEntry[];
  fromNumber: string;
  toNumber: string;
  userId?: string;
  channel?: CallChannel;
  durationSeconds?: number;
  engine?: { provider: string; model: string };
  extras?: CallEndExtras;
}) {
  return {
    callId: p.callId,
    fromNumber: p.fromNumber,
    toNumber: p.toNumber,
    transcript: p.transcript,
    // Omettre `userId` si undefined plutôt qu'envoyer null —
    // /api/calls/end fait son routing tenant en cascade.
    ...(p.userId ? { userId: p.userId } : {}),
    // Canal SIP : conditionne le mode d'envoi du recap client côté web.
    ...(p.channel ? { channel: p.channel } : {}),
    // Real wall-clock duration. calls.duration_seconds was 0 on every row
    // because this was never sent; billing graphs and Finance read it.
    ...(p.durationSeconds !== undefined
      ? { durationSeconds: Math.max(0, Math.round(p.durationSeconds)) }
      : {}),
    // Engine that took the call, stored per call by the web (Monitoring
    // shows the model; Finance prices per provider).
    ...(p.engine ? { realtimeProvider: p.engine.provider, realtimeModel: p.engine.model } : {}),
    // Connectors B3: only when defined, so a call with no clientAgent and no
    // connector sends exactly the payload it sent before.
    ...(p.extras?.clientAgentReached !== undefined ? { clientAgentReached: p.extras.clientAgentReached } : {}),
    ...(p.extras?.connectorRoute ? { connectorRoute: p.extras.connectorRoute } : {}),
  };
}

/** The payload as it may be logged: the opaque connector token is masked. */
export function redactForLog<T extends { connectorRoute?: string }>(payload: T): T {
  return payload.connectorRoute ? { ...payload, connectorRoute: '[redacted]' } : payload;
}

/**
 * POST le transcript + métadonnées à `/api/calls/end`.
 *
 * @param transcript Tableau des tours user/assistant capturés
 * @param fromNumber Numéro de l'appelant (SIP From), vide si web
 * @param toNumber   Numéro composé (SIP To), vide si web
 * @param userId     UserId du tenant — REQUIS pour les sessions web
 *                   (Phase 2) sinon `/api/calls/end` fallback sur
 *                   `resolveDefaultTenant` et leak cross-tenant (le call
 *                   de jonathanohayon1 atterrit chez patriciaelfassy1).
 * @param channel    Canal de l'appel SIP ('pstn' | 'whatsapp'). Pour les
 *                   appels WhatsApp, `/api/calls/end` envoie le recap client
 *                   en free-form dans le thread ouvert (fenêtre 24h) au lieu
 *                   d'un template froid. Omis pour les sessions web.
 */
export async function postCallEnd(
  transcript: TranscriptEntry[],
  fromNumber: string,
  toNumber: string,
  userId?: string,
  channel?: CallChannel,
  durationSeconds?: number,
  engine?: { provider: string; model: string },
  extras?: CallEndExtras,
): Promise<void> {
  const appUrl = process.env['APP_URL'];
  const secret = process.env['INTERNAL_SECRET'];
  if (!appUrl || !secret) {
    console.warn(
      '[recap] APP_URL or INTERNAL_SECRET missing — skipping recap',
    );
    return;
  }
  if (transcript.length === 0) {
    console.log('[recap] empty transcript — skipping');
    return;
  }

  const payload = buildCallEndPayload({
    callId: currentCallId(),
    transcript,
    fromNumber,
    toNumber,
    ...(userId ? { userId } : {}),
    ...(channel ? { channel } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(engine ? { engine } : {}),
    ...(extras ? { extras } : {}),
  });
  const res = await fetchWithRetry('[recap]', '/api/calls/end', payload);
  if (!res) {
    console.error(
      '[post-call] PERTE DE DONNÉES — payload pour recovery manuelle:',
      // The connector token is never logged, even in the recovery dump.
      JSON.stringify(redactForLog(payload)),
    );
    return;
  }
  const body = await res.text().catch(() => '');
  console.log(
    `[recap] /api/calls/end → ${res.status} ${body.slice(0, 200)}`,
  );
}
