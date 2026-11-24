/**
 * T5c "Ask your agent": which brain answers the call, and the two ways the
 * customer's agent (`clientAgent`, served by the web) takes part.
 *
 * - mode "lead"  ("Tamara leads the conversation"): Tamara keeps her own
 *   instructions and brain; the customer's agent is the ask_client_agent
 *   tool (src/client-agent.ts, tools/client-agent.ts).
 * - mode "voice" ("Tamara only lends her voice"): every caller turn goes to
 *   the customer's agent and its answer is spoken verbatim (create_response
 *   off), the opening line too. Same path as the legacy webhook mode, fed
 *   with the new contract ({ call_id, turn_id, language, question,
 *   caller_said, history } → { answer }, legacy `reply` accepted).
 *
 * Precedence: a tamaravox config (voxAgentId) keeps its own behaviour; then
 * clientAgent wins over the legacy agentWebhook; then agentWebhook; then
 * Tamara's own brain. clientAgent absent → exactly the previous selection.
 *
 * Fail-safe: nothing here throws, and a failed customer-agent call never
 * leaves silence (holding line, then an apology line in "voice"; the model
 * answers on its own in "lead", see toolResultText).
 */

import {
  CLIENT_AGENT_STALL_MS,
  askClientAgent,
  buildClientAgentRequest,
  isVoxToolCall,
  type ClientAgentResult,
  type ClientAgentTurn,
} from './client-agent.js';
import { stallLine, TURN_BUDGET_MS } from './agent-webhook.js';
import { createStallGate, type StallGate } from './stall-gate.js';
import type { ClientAgentConfig, ClientAgentMode } from './types.js';

export const CLIENT_AGENT_MODES: readonly ClientAgentMode[] = ['lead', 'voice'];

/**
 * Deadline for one "voice" request (a caller turn or the opening line), retry
 * included. 2 s, the same as the legacy verbatim webhook (TURN_BUDGET_MS):
 * in "voice" mode no model fills the wait, the caller only hears the holding
 * line, so this is tighter than the 2.5 s "lead" tool budget.
 */
export const CLIENT_AGENT_VOICE_BUDGET_MS = TURN_BUDGET_MS;
const MAX_URL_LENGTH = 2048;

export type ClientAgentParse =
  | { ok: true; value: ClientAgentConfig }
  | { ok: false; reason: 'not_object' | 'bad_url' | 'not_https' | 'bad_secret' | 'bad_mode' };

/**
 * Strict parse of the served `clientAgent` field. Unknown keys are dropped.
 * The reason never contains the url or the secret.
 */
export function parseClientAgent(raw: unknown): ClientAgentParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const r = raw as Record<string, unknown>;
  if (typeof r['url'] !== 'string' || !r['url'] || r['url'].length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'bad_url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(r['url']);
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (!parsed.hostname || parsed.username || parsed.password) return { ok: false, reason: 'bad_url' };
  const secret = r['secret'];
  if (secret !== undefined && secret !== null && typeof secret !== 'string') return { ok: false, reason: 'bad_secret' };
  const mode = r['mode'];
  if (typeof mode !== 'string' || !CLIENT_AGENT_MODES.includes(mode as ClientAgentMode)) {
    return { ok: false, reason: 'bad_mode' };
  }
  return {
    ok: true,
    value: {
      url: r['url'],
      ...(typeof secret === 'string' && secret ? { secret } : {}),
      mode: mode as ClientAgentMode,
    },
  };
}

/**
 * The config-fetcher spread: `{ clientAgent }` when valid, `{}` otherwise
 * (absent → silent; present but invalid → one log line with the reason).
 */
export function clientAgentField(
  raw: unknown,
  log: (line: string) => void = console.warn,
): { clientAgent?: ClientAgentConfig } {
  if (raw === undefined) return {};
  const res = parseClientAgent(raw);
  if (res.ok) return { clientAgent: res.value };
  log(`[client_agent] config ignored: ${res.reason}`);
  return {};
}

/** Host only: the path and query of a customer's url may carry tokens. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host || '?';
  } catch {
    return '?';
  }
}

export interface BrainEndpoint {
  url: string;
  secret?: string;
}

export type BrainPlan =
  /** Tamara's own brain (no external agent). */
  | { kind: 'own' }
  /** Tamara leads; the external agent is the ask_client_agent tool. */
  | { kind: 'tool'; source: 'vox' | 'client_agent'; endpoint: BrainEndpoint }
  /** Every turn goes to the external agent; its words are spoken verbatim. */
  | { kind: 'verbatim'; contract: 'legacy' | 'client_agent'; endpoint: BrainEndpoint };

export interface BrainSelection {
  plan: BrainPlan;
  /** clientAgent present AND a legacy agentWebhook too: clientAgent won. */
  overridesLegacyWebhook: boolean;
}

function endpointOf(c: { url: string; secret?: string }): BrainEndpoint {
  return { url: c.url, ...(c.secret ? { secret: c.secret } : {}) };
}

export function selectBrainPlan(
  cfg: {
    voxAgentId?: string;
    agentWebhook?: { url: string; secret?: string };
    clientAgent?: ClientAgentConfig;
  },
  env: Record<string, string | undefined> = process.env,
): BrainSelection {
  // tamaravox numbers: exactly #31's selection, clientAgent never applies.
  if (cfg.voxAgentId) {
    if (isVoxToolCall(cfg, env)) {
      return { plan: { kind: 'tool', source: 'vox', endpoint: cfg.agentWebhook! }, overridesLegacyWebhook: false };
    }
    if (cfg.agentWebhook?.url) {
      return { plan: { kind: 'verbatim', contract: 'legacy', endpoint: cfg.agentWebhook }, overridesLegacyWebhook: false };
    }
    return { plan: { kind: 'own' }, overridesLegacyWebhook: false };
  }
  if (cfg.clientAgent) {
    const overridesLegacyWebhook = Boolean(cfg.agentWebhook?.url);
    const endpoint = endpointOf(cfg.clientAgent);
    return cfg.clientAgent.mode === 'voice'
      ? { plan: { kind: 'verbatim', contract: 'client_agent', endpoint }, overridesLegacyWebhook }
      : { plan: { kind: 'tool', source: 'client_agent', endpoint }, overridesLegacyWebhook };
  }
  if (cfg.agentWebhook?.url) {
    // Passed as-is: the legacy path is byte-identical to before.
    return { plan: { kind: 'verbatim', contract: 'legacy', endpoint: cfg.agentWebhook }, overridesLegacyWebhook: false };
  }
  return { plan: { kind: 'own' }, overridesLegacyWebhook: false };
}

/** Said in "voice" mode when the customer's agent gave no usable answer. */
const APOLOGY: Record<string, string> = {
  fr: "Désolée, je n'arrive pas à vérifier pour le moment. Pouvez-vous répéter ?",
  he: 'סליחה, אני לא מצליחה לבדוק כרגע. אפשר לחזור על זה?',
  en: "Sorry, I can't check that right now. Could you say it again?",
};

export function apologyLine(language: string): string {
  return APOLOGY[language] ?? APOLOGY['en']!;
}

export type VoiceTurnOutcome =
  | 'answered'
  | NonNullable<ClientAgentResult['failure']>
  | 'error'
  /** A newer caller turn exists: this reply was not spoken. */
  | 'stale'
  /** The session closed (or is closing): nothing was spoken. */
  | 'discarded';

/**
 * One caller turn in "voice" mode. Never throws, never leaves silence:
 * - a holding line only after CLIENT_AGENT_STALL_MS (1.5 s) of waiting, and
 *   never on two consecutive turns (`stallGate`, one per call); an answer
 *   that arrives while it is being said is spoken after it, never over it;
 * - the answer, verbatim;
 * - no answer (timeout, http, shape, network, unsafe_url) or any error → the
 *   apology line;
 * - a newer caller turn already exists when the reply arrives (`isStale`) →
 *   nothing spoken: the newer turn's request carries the full history, so
 *   it answers what the caller said last;
 * - the session closed / closing (`isClosed`) → nothing spoken, one info line.
 * The request goes through askClientAgent, so through the shared poster
 * (src/net/agent-post.ts): address check at connect time, one deadline
 * (CLIENT_AGENT_VOICE_BUDGET_MS), one retry on a fresh connection for a stale
 * reused socket.
 * Logs carry the turn id, the outcome and the time only.
 */
export async function runClientAgentVoiceTurn(p: {
  endpoint: BrainEndpoint;
  /** Hashed call id (src/session-context.ts), never the room name. */
  callId: string;
  turnId: number;
  language: string;
  callerSaid: string;
  history: ClientAgentTurn[];
  speak: (text: string) => Promise<void>;
  ask?: typeof askClientAgent;
  stallMs?: number;
  /** One per call: remembers whether the previous turn said the holding line. */
  stallGate?: StallGate;
  /** True when a newer caller turn exists (queued or in flight). */
  isStale?: () => boolean;
  /** True when the session is closed or closing. */
  isClosed?: () => boolean;
  log?: (line: string) => void;
}): Promise<VoiceTurnOutcome> {
  const log = p.log ?? console.log;
  const gate = p.stallGate ?? createStallGate();
  const closed = () => {
    try {
      return p.isClosed?.() === true;
    } catch {
      return false;
    }
  };
  const stale = () => {
    try {
      return p.isStale?.() === true;
    } catch {
      return false;
    }
  };
  const discarded = (): VoiceTurnOutcome => {
    log(`[voice] turn ${p.turnId} discarded (session closed)`);
    return 'discarded';
  };

  let stalled = false;
  let holding = null as Promise<void> | null;
  const stallTimer = setTimeout(() => {
    if (!gate.mayStall() || closed()) return;
    stalled = true;
    // Not awaited here: the request keeps running. The answer waits for it
    // (below), so the two never overlap.
    holding = p.speak(stallLine(p.language)).catch(() => {});
  }, p.stallMs ?? CLIENT_AGENT_STALL_MS);

  let result: ClientAgentResult | null = null;
  let errorName: string | null = null;
  try {
    result = await (p.ask ?? askClientAgent)(
      p.endpoint,
      buildClientAgentRequest({
        callId: p.callId,
        turnId: p.turnId,
        language: p.language,
        question: p.callerSaid,
        callerSaid: p.callerSaid,
        history: p.history,
      }),
      { budgetMs: CLIENT_AGENT_VOICE_BUDGET_MS },
    );
  } catch (e) {
    // The error name only: a message could echo the url or the caller's words.
    errorName = (e as Error)?.name ?? 'Error';
  }
  clearTimeout(stallTimer);
  gate.endTurn(stalled);

  if (closed()) return discarded();
  log(
    result
      ? `[client_agent] voice turn ${p.turnId} → ${result.answer ? 'ok' : result.failure} in ${result.elapsedMs}ms`
      : `[client_agent] voice turn ${p.turnId} → error (${errorName})`,
  );
  // The holding line, if it started, finishes before anything else is said.
  if (holding) await holding;
  if (closed()) return discarded();
  if (stale()) {
    log(`[voice] turn ${p.turnId} reply dropped (stale)`);
    return 'stale';
  }

  const answer = result?.answer ?? null;
  try {
    await p.speak(answer ?? apologyLine(p.language));
    return answer ? 'answered' : result ? (result.failure ?? 'shape') : 'error';
  } catch (e) {
    if (closed()) return discarded();
    log(`[client_agent] voice turn ${p.turnId} speak failed (${(e as Error)?.name ?? 'Error'})`);
    if (answer) {
      try {
        await p.speak(apologyLine(p.language));
      } catch {
        /* nothing left to say with */
      }
    }
    return 'error';
  }
}

/**
 * The opening line in "voice" mode: turn 0, empty question, as the web's
 * test request. Returns the answer, or null (the caller then falls back to
 * the model greeting, as the legacy webhook mode does). Never throws.
 */
export async function clientAgentOpening(p: {
  endpoint: BrainEndpoint;
  callId: string;
  language: string;
  ask?: typeof askClientAgent;
  log?: (line: string) => void;
}): Promise<string | null> {
  const log = p.log ?? console.log;
  try {
    const result = await (p.ask ?? askClientAgent)(
      p.endpoint,
      buildClientAgentRequest({ callId: p.callId, turnId: 0, language: p.language, question: '', callerSaid: '', history: [] }),
      { budgetMs: CLIENT_AGENT_VOICE_BUDGET_MS },
    );
    log(`[client_agent] opening → ${result.answer ? 'ok' : result.failure} in ${result.elapsedMs}ms`);
    return result.answer;
  } catch (e) {
    log(`[client_agent] opening → error (${(e as Error)?.name ?? 'Error'})`);
    return null;
  }
}

export type VoiceTurnSubmit = 'sent' | 'queued' | 'replaced' | 'stopped';

/**
 * "voice" mode: one request in flight at a time, and no caller turn dropped.
 *
 * A caller turn that arrives while a request is in flight is kept as the
 * pending turn and sent as soon as the in-flight one finishes (answer spoken
 * or failure), with the next turn id. If several arrive meanwhile, the newest
 * REPLACES the older pending one (no concatenation): the customer's agent
 * must answer what the caller said last, and the skipped turns are not lost
 * to it, they are in the transcript, so in `history`, which `run` reads when
 * the turn is actually sent. Concatenating would invent an utterance the
 * caller never said and repeat those words in both caller_said and history.
 *
 * When the in-flight turn's reply arrives and a newer turn is already
 * pending, that reply is stale: `run` gets `isStale()` and does not speak it
 * (runClientAgentVoiceTurn), so the caller never hears an answer to what
 * they said before their last words.
 *
 * `stop()` (call end) drops the pending turn. Never throws; `run` failures
 * are swallowed (runClientAgentVoiceTurn already never throws). Logs carry
 * turn ids only, never the caller's words.
 */
export function createVoiceTurnQueue(
  run: (callerSaid: string, turnId: number, turn: { isStale: () => boolean }) => Promise<unknown>,
  log: (line: string) => void = console.log,
) {
  let inFlight = false;
  let pending: string | null = null;
  let lastTurnId = 0;
  let stopped = false;

  const send = (callerSaid: string) => {
    inFlight = true;
    lastTurnId += 1;
    const turnId = lastTurnId;
    void Promise.resolve()
      .then(() => run(callerSaid, turnId, { isStale: () => pending !== null || lastTurnId > turnId }))
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (stopped || pending === null) return;
        const next = pending;
        pending = null;
        log(`[client_agent] pending turn sent after turn ${turnId}`);
        send(next);
      });
  };

  return {
    submit(callerSaid: string): VoiceTurnSubmit {
      if (stopped) return 'stopped';
      if (!inFlight) {
        send(callerSaid);
        return 'sent';
      }
      const replaced = pending !== null;
      pending = callerSaid;
      log(`[client_agent] turn ${replaced ? 'replaces the pending one' : 'queued'} (turn ${lastTurnId} in flight)`);
      return replaced ? 'replaced' : 'queued';
    },
    stop(): void {
      stopped = true;
      pending = null;
    },
    get inFlight(): boolean {
      return inFlight;
    },
    get lastTurnId(): number {
      return lastTurnId;
    },
  };
}
