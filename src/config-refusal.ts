/**
 * When the web refuses to serve a config, the call must END, not fall back to
 * the compiled default persona. Before this, any non-200 from
 * /api/agent/config, including 403 trial_exhausted, answered the caller as the
 * historical "Tamara/Prestige" agent, so the trial gate never cut anything.
 *
 * Only these two explicit refusals hang up. Any other failure (5xx, timeout,
 * garbled body) keeps the defaults: an outage on our side must not drop calls.
 */

export type ConfigRefusal = 'unknown_number' | 'trial_exhausted';

export function refusalFromResponse(
  status: number,
  body: unknown,
): ConfigRefusal | null {
  const error =
    body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (status === 404 && error === 'unknown_number') return 'unknown_number';
  if (status === 403 && error === 'trial_exhausted') return 'trial_exhausted';
  return null;
}

/** Thrown by fetchConfig; caught in the entrypoint, which hangs up. */
export class ConfigRefusedError extends Error {
  constructor(readonly reason: ConfigRefusal) {
    super(`config refused: ${reason}`);
    this.name = 'ConfigRefusedError';
  }
}
