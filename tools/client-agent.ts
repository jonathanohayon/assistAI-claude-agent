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

export interface ClientAgentToolDeps {
  webhook: { url: string; secret?: string };
  /** Stable call id (hashed room name, src/session-context.ts). */
  getCallId: () => string;
  /** Caller's current language ('fr' | 'he' | 'en'). */
  getLanguage: () => string;
  /** Last caller turn, raw transcription. */
  getCallerSaid: () => string;
  getHistory: () => ClientAgentTurn[];
  /**
   * Starts the holding line; returns a cancel function (stops it if the
   * answer arrives before it played). Null when no holding audio is
   * available.
   */
  startStall?: () => (() => void) | null;
  /** Monitoring (/api/v1/turns), one call per tool call. */
  onResult?: (r: ClientAgentResult & { turnId: number; question: string; callerSaid: string; language: string }) => void;
  ask?: typeof askClientAgent;
}

export function makeClientAgentTools(deps: ClientAgentToolDeps) {
  let turnId = 0;
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
      const language = deps.getLanguage();
      const callerSaid = deps.getCallerSaid();
      let cancelStall: (() => void) | null = null;
      const stallTimer = setTimeout(() => {
        cancelStall = deps.startStall?.() ?? null;
      }, CLIENT_AGENT_STALL_MS);
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
      // An answer that beats the holding line must not be followed by it.
      (cancelStall as (() => void) | null)?.();
      console.log(`[client_agent] turn ${id} → ${result.answer ? 'ok' : result.failure} in ${result.elapsedMs}ms`);
      deps.onResult?.({ ...result, turnId: id, question, callerSaid, language });
      return toolResultText(result);
    },
  });
  return { ask_client_agent };
}
