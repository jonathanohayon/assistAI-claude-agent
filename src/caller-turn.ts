/**
 * T5c: what the caller just said, and in which language, for the customer's
 * agent ("lead" tool and "voice" turns alike).
 *
 * Why a tracker: on a Realtime session the caller's final transcript
 * (input_audio_transcription.completed → UserInputTranscribed) is computed in
 * parallel with the model's response. The model can call ask_client_agent
 * BEFORE the transcript of the very turn that led to the call has landed, so
 * reading "the last user line of the transcript" at that moment returns the
 * previous turn, or "" on the first one. The tracker knows a turn is still
 * being transcribed (the caller stopped speaking after the last final
 * transcript) and lets the tool wait for it, for a bounded time.
 */

import { sniffLang } from './lang-sniff.js';

/** Longest wait for the transcript of the turn that led to the tool call. */
export const CALLER_SAID_WAIT_MS = 1000;

/**
 * The caller's language for the customer's agent: Hebrew when the caller's
 * last words are Hebrew, else the account's primary language, else 'fr'
 * (the web's default for agent_configs.primary_language). The one source for
 * "lead" and "voice".
 */
export function callerLanguageOf(lastCallerText: string | undefined, primaryLanguage: string | undefined): string {
  return lastCallerText && sniffLang(lastCallerText) === 'he' ? 'he' : primaryLanguage || 'fr';
}

export function createCallerTurnTracker(waitMs: number = CALLER_SAID_WAIT_MS) {
  let lastSaid = '';
  /** The caller stopped speaking and no final transcript has arrived since. */
  let pending = false;
  let waiters: Array<() => void> = [];

  const release = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };

  return {
    /** The caller stopped speaking: a final transcript is on its way. */
    speechEnded(): void {
      pending = true;
    },
    /** A final transcript (empty text too: it ends the pending turn). */
    finalTranscript(text: string): void {
      const t = text.trim();
      if (t) lastSaid = t;
      pending = false;
      release();
    },
    /**
     * The caller's last final transcript. When a turn is still being
     * transcribed, waits for it (at most `waitMs`), then returns the newest
     * one known. Never rejects.
     */
    async callerSaid(): Promise<string> {
      if (!pending) return lastSaid;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        function done() {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== done);
          resolve();
        }
        waiters.push(done);
      });
      return lastSaid;
    },
    get pending(): boolean {
      return pending;
    },
  };
}

export type CallerTurnTracker = ReturnType<typeof createCallerTurnTracker>;
