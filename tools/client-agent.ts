import { llm } from '@livekit/agents';
import { z } from 'zod';

import {
  CLIENT_AGENT_STALL_MS,
  askClientAgent,
  buildClientAgentRequest,
  toolResultText,
  type ClientAgentResult,
  type ClientAgentTurn,
} from '../src/client-agent.js';
import { createStallGate } from '../src/stall-gate.js';

export interface ClientAgentToolDeps {
  webhook: { url: string; secret?: string };
  /** Stable call id (hashed room name, src/session-context.ts). */
  getCallId: () => string;
  /** Caller's current language ('fr' | 'he' | 'en'). */
  getLanguage: () => string;
  /**
   * Last caller turn, raw transcription. May wait (bounded) for the
   * transcript of the turn that led to the tool call (src/caller-turn.ts).
   */
  getCallerSaid: () => string | Promise<string>;
  getHistory: () => ClientAgentTurn[];
  /**
   * Starts the holding line; returns a cancel function (called when the
   * answer arrives). Null when no holding audio is available. Called only
   * after CLIENT_AGENT_STALL_MS (1.5 s) without an answer, and never on two
   * consecutive tool calls.
   */
  startStall?: () => (() => void) | null;
  /** Monitoring (/api/v1/turns), one call per tool call. */
  onResult?: (r: ClientAgentResult & { turnId: number; question: string; callerSaid: string; language: string }) => void;
  ask?: typeof askClientAgent;
}

export function makeClientAgentTools(deps: ClientAgentToolDeps) {
  let turnId = 0;
  const stallGate = createStallGate();
  const ask_client_agent = llm.tool({
    description:
      "Ask the business's own assistant. Use it for anything about this business: hours, prices, products, stock, orders, accounts, bookings, policies, specific requests. Never guess business facts: ask. Call it with nothing spoken in the same turn.",
    parameters: z.object({
      question: z
        .string()
        .describe("The caller's question, clear and complete in one sentence, with any numbers, names or dates they gave."),
    }),
    execute: async ({ question }) => {
      turnId += 1;
      const id = turnId;
      let cancelStall: (() => void) | null = null;
      let stalled = false;
      // From the request start (the wait for the caller's transcript included).
      const stallTimer = setTimeout(() => {
        if (!stallGate.mayStall()) return;
        stalled = true;
        try {
          cancelStall = deps.startStall?.() ?? null;
        } catch {
          /* no holding line: the answer still comes */
        }
      }, CLIENT_AGENT_STALL_MS);
      // Never throw out of a tool call: a throw would leave the model with no
      // result and the caller with silence. Any error = "the system did not
      // answer", and the model says so on its own (toolResultText).
      try {
        // The caller's words first: the language and the history are read
        // once their transcript is in.
        const callerSaid = await deps.getCallerSaid();
        const language = deps.getLanguage();
        const result = await (deps.ask ?? askClientAgent)(
          deps.webhook,
          buildClientAgentRequest({
            callId: deps.getCallId(),
            turnId: id,
            language,
            question,
            callerSaid,
            history: deps.getHistory(),
          }),
        );
        clearTimeout(stallTimer);
        stallGate.endTurn(stalled);
        // An answer that beats the holding line must not be followed by it.
        (cancelStall as (() => void) | null)?.();
        console.log(`[client_agent] turn ${id} → ${result.answer ? 'ok' : result.failure} in ${result.elapsedMs}ms`);
        try {
          deps.onResult?.({ ...result, turnId: id, question, callerSaid, language });
        } catch {
          /* monitoring never changes what the model is told */
        }
        return toolResultText(result);
      } catch (e) {
        clearTimeout(stallTimer);
        stallGate.endTurn(stalled);
        try {
          (cancelStall as (() => void) | null)?.();
        } catch {
          /* holding line already gone */
        }
        console.log(`[client_agent] turn ${id} → error (${(e as Error)?.name ?? 'Error'})`);
        return toolResultText({ answer: null, elapsedMs: 0, failure: 'network' });
      }
    },
  });
  return { ask_client_agent };
}
