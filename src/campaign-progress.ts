/**
 * Live call progress for outbound campaign calls → web admin console
 * (POST /api/agent/campaign-progress).
 *
 * LiveKit's SIP gateway sets `sip.callStatus` on the callee participant:
 * dialing → ringing → active → hangup. We map it to the console states and
 * report each state once, forward only. Fire-and-forget: a lost progress
 * event never affects the call (the terminal result still goes through
 * /api/agent/campaign-result).
 */

import { webPost } from './web-api.js';

export type CampaignCallState = 'ringing' | 'in_call' | 'ended';

const ORDER: CampaignCallState[] = ['ringing', 'in_call', 'ended'];

/** `sip.callStatus` → console state. 'dialing' is set by the web when it dials. */
export function callStateFromSipStatus(status: string | undefined): CampaignCallState | null {
  switch (status) {
    case 'ringing':
      return 'ringing';
    case 'active':
      return 'in_call';
    case 'hangup':
      return 'ended';
    default:
      return null;
  }
}

export interface ProgressPayload {
  campaignId: string;
  contactId: string;
  state: CampaignCallState;
  sipStatus?: string;
  durationSeconds?: number;
}

export type ProgressPoster = (payload: ProgressPayload) => Promise<void>;

const defaultPoster: ProgressPoster = async (payload) => {
  try {
    const res = await webPost('/api/agent/campaign-progress', payload, { timeoutMs: 3_000 });
    if (!res.ok) console.warn(`[campaign-progress] ${payload.state} → HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[campaign-progress] ${payload.state} failed: ${(e as Error).message}`);
  }
};

export interface CampaignProgressReporter {
  /** Feed every `sip.callStatus` seen on the callee participant. */
  onSipStatus(status: string | undefined): void;
  /** Call is over (session closing): reports 'ended' with the talk time. */
  ended(): void;
}

export function createCampaignProgressReporter(
  ids: { campaignId: string; contactId: string },
  post: ProgressPoster = defaultPoster,
  now: () => number = Date.now,
): CampaignProgressReporter {
  let last = -1;
  let answeredAt: number | null = null;

  const report = (state: CampaignCallState, sipStatus?: string) => {
    const idx = ORDER.indexOf(state);
    if (idx <= last) return;
    last = idx;
    if (state === 'in_call') answeredAt = now();
    const payload: ProgressPayload = { ...ids, state };
    if (sipStatus) payload.sipStatus = sipStatus;
    if (state === 'ended') {
      payload.durationSeconds = answeredAt === null ? 0 : Math.round((now() - answeredAt) / 1000);
    }
    void post(payload);
  };

  return {
    onSipStatus(status) {
      const state = callStateFromSipStatus(status);
      if (state) report(state, status);
    },
    ended() {
      report('ended');
    },
  };
}
