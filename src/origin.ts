/**
 * Détection de l'origine d'une session — SIP (Twilio) ou Web (LiveTest).
 *
 * LiveKit Cloud route les 2 vers le même worker. On distingue à partir
 * des `attributes` (SIP) ou `metadata` (Web) du participant remote :
 *
 *   - SIP Twilio  : participant.attributes["sip.trunkPhoneNumber"] = numéro composé
 *   - Web LiveTest: participant.metadata = JSON {"source":"web","userId":"<uuid>"}
 *
 * Cf. /api/livekit/web-token côté repo web qui injecte la metadata.
 */

import type { JobContext } from '@livekit/agents';

import { ORIGIN_DETECTION_TIMEOUT_MS } from './constants.js';
import type { CallChannel, ProcessUserData, SessionOrigin } from './types.js';

/**
 * Numéro de l'appelant (From) depuis un participant SIP Twilio.
 *
 * LiveKit Cloud expose 2 attributes posés par le SIP gateway :
 *   - `sip.phoneNumber`      = numéro de l'appelant (From)
 *   - `sip.trunkPhoneNumber` = numéro composé (To, ligne du tenant)
 *
 * L'identity du participant est aussi `sip_<from>` comme fallback si les
 * attributes n'arrivent pas (rare).
 */
export function sipFromOf(p: {
  attributes: Record<string, string>;
  identity: string;
}): string {
  const attr = p.attributes['sip.phoneNumber'];
  if (attr) return attr;
  return p.identity.startsWith('sip_') ? p.identity.slice(4) : '';
}

/**
 * Numéro composé (To) depuis un participant SIP Twilio.
 * Sert à résoudre le tenant via `/api/agent/config?phone=...`.
 *
 * Les appels WhatsApp empruntent le MÊME chemin SIP que les appels PSTN,
 * mais le numéro composé est préfixé `whatsapp:` (ex: `whatsapp:+972237647000`).
 * On détecte ce préfixe pour poser le `channel` et on retourne :
 *   - `raw`          : la valeur brute de l'attribute (préfixe inclus)
 *   - `channel`      : `'whatsapp'` si préfixé, sinon `'pstn'`
 *   - `calledNumber` : le numéro NU (préfixe `whatsapp:` retiré) — c'est lui
 *                      qu'on envoie à `/api/agent/config?phone=...`.
 *
 * Si l'attribute est absent → `{ raw:'', channel:'pstn', calledNumber:'' }`.
 */
export function sipToOf(p: { attributes: Record<string, string> }): {
  raw: string;
  channel: CallChannel;
  calledNumber: string;
} {
  const raw = p.attributes['sip.trunkPhoneNumber'] ?? '';
  const WA_PREFIX = 'whatsapp:';
  if (raw.startsWith(WA_PREFIX)) {
    return { raw, channel: 'whatsapp', calledNumber: raw.slice(WA_PREFIX.length) };
  }
  return { raw, channel: 'pstn', calledNumber: raw };
}

/**
 * Lit `participant.metadata` (JSON) pour détecter un participant web
 * (Phase 2 LiveTest routing).
 *
 * Format émis par `/api/livekit/web-token` :
 *   `{ "source": "web", "userId": "<uuid>" }`
 *
 * Retourne userId si trouvé, sinon null. Silent sur metadata invalide
 * (parse error) pour ne pas crasher l'agent.
 */
export function webUserIdOf(p: { metadata?: string }): string | null {
  if (!p.metadata) return null;
  try {
    const parsed = JSON.parse(p.metadata) as {
      source?: string;
      userId?: string;
    };
    if (parsed.source === 'web' && typeof parsed.userId === 'string') {
      return parsed.userId;
    }
  } catch {
    // metadata absente ou pas JSON → pas un participant web
  }
  return null;
}

/**
 * Détecte l'origine de la session en pollant les remoteParticipants
 * jusqu'à ce que les attributes / metadata arrivent. Le SDK LiveKit
 * publie ces données un beat après `connect()` retourne, donc on
 * polling sur 100ms d'intervalle.
 *
 * Time-bounded à `ORIGIN_DETECTION_TIMEOUT_MS` pour ne jamais bloquer
 * un appel — au-delà on retourne `unknown` et le worker fallback sur
 * default tenant.
 */
// Appel sortant de campagne : la metadata de dispatch (ctx.job.metadata)
// porte source=campaign + les ids. Disponible immédiatement (pas besoin
// d'attendre les attributs SIP) → on court-circuite la détection.
function campaignOriginOf(ctx: JobContext<ProcessUserData>): SessionOrigin | null {
  try {
    const raw = (ctx.job?.metadata ?? '').trim();
    if (!raw) return null;
    const meta = JSON.parse(raw) as {
      source?: string;
      campaignId?: string;
      contactId?: string;
      userId?: string;
    };
    if (
      meta.source === 'campaign' &&
      meta.campaignId &&
      meta.contactId &&
      meta.userId
    ) {
      return {
        kind: 'campaign',
        campaignId: meta.campaignId,
        contactId: meta.contactId,
        userId: meta.userId,
      };
    }
  } catch {
    /* metadata non-JSON ou absente → ce n'est pas une campagne */
  }
  return null;
}

export async function detectOrigin(
  ctx: JobContext<ProcessUserData>,
  timeoutMs: number = ORIGIN_DETECTION_TIMEOUT_MS,
): Promise<SessionOrigin> {
  // Campagne sortante : prioritaire, dispo dès le dispatch.
  const campaign = campaignOriginOf(ctx);
  if (campaign) return campaign;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const [, p] of ctx.room.remoteParticipants) {
      // 1. SIP attributes (Twilio) — PSTN ou WhatsApp (préfixe `whatsapp:`)
      const sip = sipToOf(p);
      if (sip.raw)
        return { kind: 'sip', calledNumber: sip.calledNumber, channel: sip.channel };
      // 2. Web metadata (Phase 2 LiveTest)
      const userId = webUserIdOf(p);
      if (userId) return { kind: 'web', userId };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { kind: 'unknown' };
}
