/**
 * Hook post-appel — POST le transcript final à `/api/calls/end` côté web.
 *
 * Le web service prend le relais :
 *   1. Génère un summary LLM (cf. lib/summarize.ts) avec le ton du plan
 *   2. Envoie un WhatsApp client (recap rendez-vous) si numéro disponible
 *   3. Envoie un WhatsApp owner (recap proprio) si owner_whatsapp set
 *   4. Persiste l'appel en DB pour audit + dashboard logs
 *
 * Best-effort : la fonction ne throw JAMAIS. Si le POST échoue (network,
 * 500 côté web, etc.), on log l'erreur localement et on continue. Une
 * échec ici ne doit pas crasher l'agent qui est peut-être encore en
 * traitement d'autres calls parallèles.
 */

import { POST_CALL_TIMEOUT_MS } from './constants.js';
import type { TranscriptEntry } from './types.js';

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
 */
export async function postCallEnd(
  transcript: TranscriptEntry[],
  fromNumber: string,
  toNumber: string,
  userId?: string,
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

  try {
    const res = await fetch(`${appUrl}/api/calls/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({
        fromNumber,
        toNumber,
        transcript,
        // Omettre `userId` si undefined plutôt qu'envoyer null —
        // /api/calls/end fait son routing tenant en cascade.
        ...(userId ? { userId } : {}),
      }),
      signal: AbortSignal.timeout(POST_CALL_TIMEOUT_MS),
    });
    const body = await res.text();
    console.log(
      `[recap] /api/calls/end → ${res.status} ${body.slice(0, 200)}`,
    );
  } catch (e) {
    console.error(`[recap] failed: ${(e as Error).message}`);
  }
}
