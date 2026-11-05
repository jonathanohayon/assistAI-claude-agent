/**
 * Per-call session context, propagated through the async chain of a call
 * (AsyncLocalStorage). Lives in its own module so both remote-log.ts and
 * web-api.ts can read it without an import cycle.
 *
 * - `origin`: who/what the call is (resolves user_id on the web for events).
 * - `callId`: the LiveKit room name of the call. Sent as `x-call-id` on every
 *   web request and as `metadata.callId` on every event, so the web ties
 *   tool events to THEIR call even when a busy line has overlapping calls.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface SessionContext {
  origin?: {
    kind?: 'sip' | 'web' | 'campaign' | 'outbound_test' | 'unknown';
    userId?: string;
    calledNumber?: string;
    campaignId?: string;
    contactId?: string;
    agentId?: string;
  };
  callId?: string;
}

const sessionContext = new AsyncLocalStorage<SessionContext>();

/** Run `fn` with this context for every async continuation inside it. */
export function runWithSession<T>(ctx: SessionContext, fn: () => Promise<T>): Promise<T> {
  return sessionContext.run(ctx, fn);
}

/** Set the context for the rest of the current async chain (entry()). */
export function enterSession(ctx: SessionContext): void {
  sessionContext.enterWith(ctx);
}

export function currentSession(): SessionContext | undefined {
  return sessionContext.getStore();
}

/** Call id of the current call, or undefined outside a call. */
export function currentCallId(): string | undefined {
  return sessionContext.getStore()?.callId || undefined;
}
