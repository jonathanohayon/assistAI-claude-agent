/**
 * Call transfer to the business owner (per-tenant transferNumber, web #152).
 *
 * A SIP REFER through LiveKit (SipClient.transferSipParticipant): the
 * caller's SIP leg is handed to the owner's number and leaves the room; the
 * agent's job then ends. PSTN calls only (no SIP leg to refer on WhatsApp or
 * web calls). Pure helpers are unit-tested in tests/transfer.test.ts.
 */
import { SipClient } from 'livekit-server-sdk';

import { sipFromOf } from './origin.js';

export type TransferResult = { ok: true } | { ok: false; error: string };

/** Only real phone calls with a configured number can be transferred:
 *  inbound PSTN, or an outbound campaign call (its callee is a SIP leg). */
export function transferEligible(args: {
  originKind: string;
  channel?: string | undefined;
  transferNumber?: string | null | undefined;
}): boolean {
  const phoneLeg =
    (args.originKind === 'sip' && (args.channel ?? 'pstn') === 'pstn') ||
    args.originKind === 'campaign';
  return phoneLeg && /^\+[1-9]\d{7,14}$/.test(args.transferNumber ?? '');
}

/** SIP REFER target for an E.164 number. */
export function transferTarget(e164: string): string {
  return `tel:${e164}`;
}

/** The caller's SIP participant identity (the leg to transfer), or null. */
export function findSipCallerIdentity(
  participants: Iterable<{ identity: string; attributes: Record<string, string> }>,
): string | null {
  for (const p of participants) {
    if (sipFromOf(p)) return p.identity;
  }
  return null;
}

/** Performs the REFER. Never throws. */
export async function transferCall(args: {
  roomName: string;
  participantIdentity: string;
  transferNumber: string;
}): Promise<TransferResult> {
  const lkUrl = process.env['LIVEKIT_URL'];
  const lkKey = process.env['LIVEKIT_API_KEY'];
  const lkSecret = process.env['LIVEKIT_API_SECRET'];
  if (!lkUrl || !lkKey || !lkSecret) return { ok: false, error: 'livekit_env_missing' };
  const httpUrl = lkUrl.replace(/^wss?:\/\//, (m) => (m === 'wss://' ? 'https://' : 'http://'));
  try {
    await new SipClient(httpUrl, lkKey, lkSecret).transferSipParticipant(
      args.roomName,
      args.participantIdentity,
      transferTarget(args.transferNumber),
      { playDialtone: true },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}
