/**
 * tamaravox BYO, step A: the client's agent is a TOOL of the Realtime brain
 * (spec tamaravox docs/specs/2026-11-09-agent-client-comme-outil.md).
 *
 * Tamara keeps her own instructions and answers on her own whatever she can;
 * for anything about the business she calls `ask_client_agent`, which POSTs
 * to the client's webhook and returns its `answer` for Tamara to rephrase.
 *
 * Only for numbers served by a tamaravox config (cfg.voxAgentId). aitamara
 * tenants never reach this module, whatever their config says.
 *
 * Rollback: VOX_VERBATIM=1 on the worker restores the previous mode (every
 * caller turn sent to the webhook and its reply spoken verbatim). That path
 * is removed once a real call has proven this one.
 */

import { createHmac } from 'node:crypto';

/** Whole budget for one tool call (network + client LLM). */
export const CLIENT_AGENT_BUDGET_MS = 2500;
/** After this, the holding line plays while we keep waiting. */
export const CLIENT_AGENT_STALL_MS = 700;
/** History sent with each question: the last N turns. */
export const CLIENT_AGENT_HISTORY_TURNS = 6;

export function voxToolModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['VOX_VERBATIM'] !== '1';
}

/** True only for a tamaravox call in tool mode. aitamara configs → false. */
export function isVoxToolCall(
  cfg: { voxAgentId?: string; agentWebhook?: { url: string } },
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(cfg.voxAgentId && cfg.agentWebhook?.url) && voxToolModeEnabled(env);
}

export interface ClientAgentTurn {
  role: 'user' | 'agent';
  text: string;
}

export interface ClientAgentRequest {
  call_id: string;
  turn_id: number;
  language: string;
  question: string;
  caller_said: string;
  history: ClientAgentTurn[];
}

export function buildClientAgentRequest(p: {
  callId: string;
  turnId: number;
  language: string;
  question: string;
  callerSaid: string;
  history: ClientAgentTurn[];
}): ClientAgentRequest {
  return {
    call_id: p.callId,
    turn_id: p.turnId,
    language: p.language,
    question: p.question.trim(),
    caller_said: p.callerSaid.trim(),
    history: p.history.slice(-CLIENT_AGENT_HISTORY_TURNS),
  };
}

export interface ClientAgentResult {
  answer: string | null;
  elapsedMs: number;
  failure?: 'timeout' | 'http' | 'shape' | 'network';
  status?: number;
}

/**
 * Calls the client's agent. Never throws. `answer` is the contract field;
 * `reply` (the previous contract) is accepted as a fallback so existing
 * demo agents keep working during the switch.
 */
export async function askClientAgent(
  webhook: { url: string; secret?: string },
  request: ClientAgentRequest,
  opts: { budgetMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ClientAgentResult> {
  const body = JSON.stringify(request);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Tamara-Voice/1.0',
  };
  if (webhook.secret) {
    headers['X-Tamara-Signature'] = createHmac('sha256', webhook.secret).update(body).digest('hex');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.budgetMs ?? CLIENT_AGENT_BUDGET_MS);
  const startedAt = Date.now();
  try {
    const res = await (opts.fetchImpl ?? fetch)(webhook.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok) return { answer: null, elapsedMs, failure: 'http', status: res.status };
    let answer: string | null = null;
    try {
      const parsed = JSON.parse(await res.text()) as { answer?: unknown; reply?: unknown };
      const raw = typeof parsed.answer === 'string' ? parsed.answer : parsed.reply;
      if (typeof raw === 'string' && raw.trim()) answer = raw.trim();
    } catch {
      // non-JSON body → shape failure below
    }
    if (!answer) return { answer: null, elapsedMs, failure: 'shape', status: res.status };
    return { answer, elapsedMs, status: res.status };
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    return { answer: null, elapsedMs, failure: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** What the model gets back from the tool (it decides the spoken words). */
export function toolResultText(result: ClientAgentResult): string {
  if (result.answer) {
    return [
      `The business's assistant answered: «${result.answer}»`,
      'Tell the caller in their language. You may rephrase and translate, but repeat EXACTLY, unchanged: prices, dates, times, numbers, names, quantities and any yes/no.',
      'If the answer does not make sense for the question, say you will check again or ask the caller to clarify; never fill the gap yourself.',
    ].join('\n');
  }
  return "The business's system did not answer. Tell the caller, in one short sentence in their language, that you can't check this right now, and offer to take a message (name, number, what it's about). Do not guess the answer.";
}
