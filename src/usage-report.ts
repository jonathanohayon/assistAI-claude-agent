import { webPost } from './web-api.js';

/**
 * End-of-call OpenAI token usage → web `/api/agent/usage`.
 *
 * The admin Finance box prices OpenAI from these events; without them it
 * falls back to an estimate (call minutes × a flat rate).
 *
 * Token semantics expected by lib/finance/cost.ts on the web side: it bills
 * `inputTokens` at the full input rate and `cachedTokens` at the cached rate,
 * summed. So `inputTokens` here is the UNCACHED part only — sending the raw
 * total would bill cached tokens twice.
 */

export interface CallUsage {
  callId: string;
  model: string;
  /** Total input tokens, cached included (as reported by Realtime). */
  inputTokensTotal: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Call wall-clock these tokens cover; the web estimates only the rest. */
  durationSeconds: number;
  /** Worker-side exact cost (src/pricing), stored for reconciliation. */
  costUsd: number;
  /** Lets the web resolve the tenant: web userId, or the called number (SIP). */
  userId?: string | undefined;
  toNumber?: string | undefined;
}

export function buildUsagePayload(u: CallUsage): Record<string, unknown> | null {
  const cached = Math.max(0, Math.min(u.cachedInputTokens, u.inputTokensTotal));
  const uncached = Math.max(0, u.inputTokensTotal - cached);
  const output = Math.max(0, u.outputTokens);
  // The route rejects an all-zero body; a call that never reached the model
  // has nothing to bill anyway.
  if (uncached === 0 && cached === 0 && output === 0) return null;

  return {
    callId: u.callId,
    model: u.model,
    inputTokens: uncached,
    cachedTokens: cached,
    outputTokens: output,
    durationSeconds: Math.max(0, Math.round(u.durationSeconds)),
    costUsd: Number.isFinite(u.costUsd) ? u.costUsd : undefined,
    ...(u.userId ? { userId: u.userId } : {}),
    ...(u.toNumber ? { toNumber: u.toNumber } : {}),
  };
}

/** Best-effort: never throws, never blocks the call teardown for long. */
export async function reportUsage(u: CallUsage): Promise<void> {
  const payload = buildUsagePayload(u);
  if (!payload) return;
  if (!process.env['APP_URL'] || !process.env['INTERNAL_SECRET']) return;
  try {
    const res = await webPost('/api/agent/usage', payload, { timeoutMs: 5_000 });
    if (!res.ok) console.warn(`[usage] /api/agent/usage → ${res.status}`);
  } catch (e) {
    console.warn(`[usage] report failed (${(e as Error).message})`);
  }
}
