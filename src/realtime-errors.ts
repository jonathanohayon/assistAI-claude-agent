/**
 * Classification of OpenAI Realtime `error` server events.
 *
 * - benign: SDK/OpenAI races with no runtime impact (logged as warn).
 * - fatal: the session can never work for this call (bad key, no quota,
 *   unknown model…). Retrying only multiplies the error: on 24–25/10/2026 an
 *   invalid key produced 137,470 error events for what looked like one call.
 *   The call must end at once, with a single error event.
 * - other: logged as error; the session carries on.
 */

export type RealtimeErrorKind = 'benign' | 'fatal' | 'other';

const BENIGN_CODES = new Set(['response_cancel_not_active']);

const FATAL_CODES = new Set([
  'invalid_api_key',
  'insufficient_quota',
  'account_deactivated',
  'billing_hard_limit_reached',
  'model_not_found',
  'invalid_organization',
  'unsupported_country_region_territory',
  // Gemini Live (normalised by geminiErrorCode below)
  'gemini_auth',
  'gemini_quota',
  'gemini_invalid_request',
]);

export function classifyRealtimeError(code: string | undefined | null): RealtimeErrorKind {
  if (!code) return 'other';
  if (BENIGN_CODES.has(code)) return 'benign';
  if (FATAL_CODES.has(code)) return 'fatal';
  return 'other';
}

/**
 * Per-call gate so a fatal error is reported and acted on exactly once,
 * however many times OpenAI repeats it before the session is torn down.
 */
export function createFatalGate(): (code: string) => boolean {
  let fired = false;
  return (code: string) => {
    if (fired || classifyRealtimeError(code) !== 'fatal') return false;
    fired = true;
    return true;
  };
}

/**
 * Gemini Live reports session failures by closing the WebSocket (code +
 * reason text), surfaced by the plugin as one `realtime_model_error` whose
 * error carries `statusCode` and `body.reason`. Maps them to a code the gate
 * above understands, so a bad key or a project without billing ends the call
 * loudly instead of leaving the caller in silence.
 */
export function geminiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as {
    statusCode?: number;
    message?: string;
    body?: { reason?: string; code?: number } | null;
  };
  const code = e.statusCode ?? e.body?.code;
  const text = `${e.body?.reason ?? ''} ${e.message ?? ''}`;
  if (/api[ _-]?key|permission|unauthori[sz]ed|unauthenticated|PERMISSION_DENIED/i.test(text)) {
    return 'gemini_auth';
  }
  if (/quota|billing|RESOURCE_EXHAUSTED|rate limit/i.test(text)) return 'gemini_quota';
  if (code === 1008) return 'gemini_auth'; // policy violation: auth/permission
  if (code === 1007 || /not found|not supported|invalid argument/i.test(text)) {
    return 'gemini_invalid_request'; // e.g. unknown model name
  }
  return null;
}
