/**
 * T5c holding line ("Un instant, je vérifie."), "lead" and "voice" alike:
 * - only after STALL_AFTER_MS of real waiting for the customer's agent (a
 *   timer from the request start, cancelled by the answer);
 * - never on two consecutive turns: when the previous turn spoke it, this
 *   turn waits in silence (the caller just heard it).
 */

export const STALL_AFTER_MS = 1500;

export interface StallGate {
  /** May this turn speak the holding line? */
  mayStall(): boolean;
  /** End of a turn: did it speak the holding line? */
  endTurn(stalled: boolean): void;
}

/** One per call. */
export function createStallGate(): StallGate {
  let previousTurnStalled = false;
  return {
    mayStall: () => !previousTurnStalled,
    endTurn: (stalled) => {
      previousTurnStalled = stalled;
    },
  };
}
