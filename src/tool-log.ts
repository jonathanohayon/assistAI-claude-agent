/**
 * One log line per tool call: `[tool] <name> args=<json>`.
 *
 * Logged when the tool is invoked (before any HTTP call), next to each tool's
 * existing outcome logs. Sink: console.log only (Railway logs) — tool events
 * have never gone through remoteLog (only the transfer outcome does, and it
 * still does), so this stays out of the dashboard event stream.
 *
 * Privacy: only argument keys on the tool's explicit ALLOWLIST are kept, and
 * only if their value is a short non-personal token (date, time, id, enum,
 * number, boolean). Names, phone numbers, emails, free text (notes, messages,
 * queries, the caller's words) and addresses are never on an allowlist; a
 * value that looks like a phone number or an email is dropped even when its
 * key is allowlisted.
 */

/** A key is either kept as a short token, or only when its value is in an enum. */
export type AllowRule = string | { key: string; oneOf: readonly string[] };

const END_CALL_REASONS = [
  'appointment_booked',
  'appointment_cancelled',
  'appointment_rescheduled',
  'information_given',
  'client_requested_hangup',
  'no_response',
  'voicemail',
  'llm_end',
] as const;

const TRANSFER_REASONS = [
  'caller_asked_for_person',
  'cannot_help',
  'complaint',
  'urgent',
] as const;

/**
 * Per-tool allowlist. A tool missing from this map logs `args={}`.
 * Deliberately absent keys: name, phone, email, description, notes, message,
 * caller_name, query, item (free text / personal).
 */
export const TOOL_LOG_ALLOWLIST: Readonly<Record<string, readonly AllowRule[]>> = {
  // tools/calendar.ts
  list_available_dates: ['center', 'count', 'after'],
  check_availability: ['date', 'center', 'duration'],
  book_appointment: ['date', 'time', 'center', 'duration'],
  save_contact: [],
  find_appointment: ['date'],
  cancel_appointment: ['event_id'],
  reschedule_appointment: ['event_id', 'new_date', 'new_time', 'center', 'duration'],
  // tools/orders.ts
  record_order: ['quantity', 'center'],
  // tools/business.ts
  list_centres: [],
  get_centre_info: ['centreId'],
  get_opening_hours: ['centreId', 'day', 'isoDate'],
  list_services: ['centreId'],
  find_service: ['centreId'],
  // agent.ts
  end_call: [{ key: 'reason', oneOf: END_CALL_REASONS }],
  transfer_call: [{ key: 'reason', oneOf: TRANSFER_REASONS }],
};

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
// Short single-token values only: no spaces, so no sentence can slip through.
const TOKEN_RE = /^[\p{L}\p{N}_:.-]{1,128}$/u;

const digitCount = (s: string): number => (s.match(/\d/g) ?? []).length;

/** True if the value looks like a phone number (7+ digits, not a date/time). */
export const looksLikePhone = (s: string): boolean => {
  const t = s.trim();
  if (DATE_RE.test(t) || TIME_RE.test(t)) return false;
  return /^\+?[\d\s().-]+$/.test(t) && digitCount(t) >= 7;
};

export const looksLikeEmail = (s: string): boolean => EMAIL_RE.test(s);

const safeValue = (v: unknown): string | number | boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return undefined;
    // A phone number passed as a number is still a phone number.
    return digitCount(String(Math.trunc(Math.abs(v)))) >= 7 ? undefined : v;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t || looksLikeEmail(t) || looksLikePhone(t)) return undefined;
    return TOKEN_RE.test(t) ? t : undefined;
  }
  return undefined; // null, undefined, objects, arrays
};

/** Keep only allowlisted, non-personal values. Pure (exported for tests). */
export const scrubToolArgs = (
  args: unknown,
  allowlist: readonly AllowRule[],
): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {};
  if (!args || typeof args !== 'object') return out;
  const src = args as Record<string, unknown>;
  for (const rule of allowlist) {
    const key = typeof rule === 'string' ? rule : rule.key;
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = safeValue(src[key]);
    if (v === undefined) continue;
    if (typeof rule !== 'string' && !(typeof v === 'string' && rule.oneOf.includes(v))) continue;
    out[key] = v;
  }
  return out;
};

/** The exact line logged for a tool call. */
export const formatToolCall = (
  name: string,
  args: unknown,
  allowlist: readonly AllowRule[] = TOOL_LOG_ALLOWLIST[name] ?? [],
): string => `[tool] ${name} args=${JSON.stringify(scrubToolArgs(args, allowlist))}`;

/** Log one `[tool]` line. Never throws (logging must not break a call). */
export const logToolCall = (
  name: string,
  args: unknown,
  allowlist?: readonly AllowRule[],
): void => {
  try {
    console.log(formatToolCall(name, args, allowlist));
  } catch {
    /* best-effort */
  }
};
