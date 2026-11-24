/**
 * Startup warnings for the calendar / sheet tools: without INTERNAL_SECRET
 * or a dialed number, the web routes those tools call fall back to the demo
 * (admin) account. The warnings only mean something when at least one such
 * tool is registered for this session — on the neutral fallback (end_call
 * only) they would mislead an incident log.
 */
export const DEMO_FALLBACK_SECRET_WARNING =
  '[tools] INTERNAL_SECRET not set — calendar/sheet calls will fall back to the demo (admin) account on the web service.';
export const DEMO_FALLBACK_NUMBER_WARNING =
  '[tools] dialed number unresolved — calendar/sheet calls will fall back to the demo (admin) account on the web service.';

export interface DemoFallbackInput {
  /** Names of the registered calendar / sheet tools (keys of the tool maps). */
  tenantRoutedToolNames: readonly string[];
  internalSecret: string;
  dialedNumber: string;
}

/** The warnings to print for this session, in order (possibly none). */
export function demoFallbackWarnings(input: DemoFallbackInput): string[] {
  if (input.tenantRoutedToolNames.length === 0) return [];
  const out: string[] = [];
  if (!input.internalSecret) out.push(DEMO_FALLBACK_SECRET_WARNING);
  if (!input.dialedNumber) out.push(DEMO_FALLBACK_NUMBER_WARNING);
  return out;
}
