/**
 * Connectors B3: did this call reach the customer's agent (T5c clientAgent)?
 *
 * Reported to the web as `clientAgentReached` in the /api/calls/end payload:
 * - true: at least one request to the customer's agent returned a usable
 *   answer ("lead": the tool got an answer; "voice": a reply was spoken,
 *   opening line included);
 * - false: a clientAgent was served, at least one request was made, and none
 *   succeeded (timeouts, errors, refused urls, bad replies);
 * - absent: no clientAgent served for this call, OR one was served but never
 *   asked (e.g. "lead" mode where the model never called the tool). So
 *   "unreachable" always means a real failed attempt.
 *
 * Only the T5c clientAgent is tracked: tamaravox numbers (voxAgentId) and the
 * legacy agentWebhook never set it, so their payloads are unchanged.
 */

export interface ClientAgentReachTracker {
  /** One finished request to the customer's agent: answered or not. */
  record(answered: boolean): void;
  /** true / false as above; undefined = no attempt (key omitted). */
  readonly reached: boolean | undefined;
}

export function createClientAgentReachTracker(): ClientAgentReachTracker {
  let attempts = 0;
  let successes = 0;
  return {
    record(answered: boolean) {
      attempts += 1;
      if (answered) successes += 1;
    },
    get reached() {
      if (attempts === 0) return undefined;
      return successes > 0;
    },
  };
}

/**
 * `connectorRoute`: an OPAQUE signed token the web serves in the session
 * config on connector routes only. The worker never parses it: it is echoed
 * back unchanged in /api/calls/end. A non-string or empty value is ignored
 * (absent). Its value is never logged.
 */
export function connectorRouteField(raw: unknown): { connectorRoute?: string } {
  return typeof raw === 'string' && raw.length > 0 ? { connectorRoute: raw } : {};
}

/** The one call-end log line: never the url, the secret or the connector token. */
export function clientAgentReachLogLine(reached: boolean | undefined, connectorRoute: string | undefined): string | null {
  if (reached === undefined) return null;
  return `[client-agent] reached=${reached} connector=${connectorRoute ? 'yes' : 'no'}`;
}

/**
 * The optional /api/calls/end fields, or undefined when there is nothing to
 * add (then postCallEnd builds exactly today's payload).
 */
export function callEndExtras(
  reached: boolean | undefined,
  connectorRoute: string | undefined,
): { clientAgentReached?: boolean; connectorRoute?: string } | undefined {
  if (reached === undefined && !connectorRoute) return undefined;
  return {
    ...(reached !== undefined ? { clientAgentReached: reached } : {}),
    ...(connectorRoute ? { connectorRoute } : {}),
  };
}
