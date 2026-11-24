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
 *
 * Barge-in over the greeting: the caller's speech reaches the server as
 * several short segments (the part said over the greeting is muted or
 * silenced, the rest is cut by the server VAD), each with its own
 * speech_stopped and its own final transcript, delivered in any order. So the
 * tracker counts the turns still being transcribed: a final transcript of an
 * EARLIER segment (often empty: a clipped fragment) no longer ends the wait
 * for the segment that actually led to the tool call. And when no final text
 * is in by the end of the wait, the newest interim transcript (the deltas the
 * voice path's UserInputTranscribed stream also carries) is used, so a caller
 * who spoke is never sent as "".
 */

import { sniffLang } from './lang-sniff.js';

/**
 * Longest wait for the transcript of the turn that led to the tool call.
 * Unchanged (1 s): the lead budget is 2.5 s in all, and the interim fallback
 * covers a transcript later than that.
 */
export const CALLER_SAID_WAIT_MS = 1000;

/** Where `callerSaid` came from (logged, never the words themselves). */
export type CallerSaidSource = 'final' | 'interim' | 'none';

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
  /** Turns the caller ended (speech_stopped) whose final transcript is not in. */
  let outstanding = 0;
  /** One clock for interim and final transcripts: the newest one wins. */
  let seq = 0;
  let lastSaidSeq = -1;
  /** Newest interim text per item still awaiting its final (key '' without an id). */
  const interims = new Map<string, { text: string; seq: number }>();
  let waiters: Array<() => void> = [];

  const release = () => {
    const w = waiters;
    waiters = [];
    for (const fn of w) fn();
  };

  const read = (): { text: string; source: CallerSaidSource } => {
    let interim: { text: string; seq: number } | undefined;
    for (const v of interims.values()) if (!interim || v.seq > interim.seq) interim = v;
    if (interim && interim.seq > lastSaidSeq) return { text: interim.text, source: 'interim' };
    if (lastSaid) return { text: lastSaid, source: 'final' };
    return { text: '', source: 'none' };
  };

  const callerSaidWithSource = async (): Promise<{ text: string; source: CallerSaidSource; waitedMs: number }> => {
    if (outstanding === 0) return { ...read(), waitedMs: 0 };
    const started = Date.now();
    const timedOut = await new Promise<boolean>((resolve) => {
      const onRelease = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== onRelease);
        resolve(true);
      }, waitMs);
      waiters.push(onRelease);
    });
    // Turns given up on are not awaited again by the next tool call; a late
    // final transcript still updates the caller's last words.
    if (timedOut) outstanding = 0;
    return { ...read(), waitedMs: Date.now() - started };
  };

  return {
    /** The caller stopped speaking: a final transcript is on its way. */
    speechEnded(): void {
      outstanding += 1;
    },
    /** A partial transcript (the accumulated deltas) of item `itemId`. */
    interimTranscript(text: string, itemId?: string | null): void {
      const t = text.trim();
      if (!t) return;
      interims.set(itemId ?? '', { text: t, seq: seq++ });
    },
    /**
     * A final transcript (empty text too: it ends one pending turn). An empty
     * final keeps that item's interim text, if any, as the caller's words.
     */
    finalTranscript(text: string, itemId?: string | null): void {
      const key = itemId ?? '';
      const t = text.trim();
      const interim = interims.get(key);
      interims.delete(key);
      if (t) {
        lastSaid = t;
        lastSaidSeq = seq++;
      } else if (interim && interim.seq > lastSaidSeq) {
        // Its words, at the time they were heard: never over a newer final.
        lastSaid = interim.text;
        lastSaidSeq = interim.seq;
      }
      if (outstanding > 0) outstanding -= 1;
      if (outstanding === 0) release();
    },
    /**
     * The caller's last words. When a turn is still being transcribed, waits
     * for it (at most `waitMs`), then returns the newest of: the last final
     * transcript, or the interim text of a turn whose final is still missing.
     * Never rejects, never invents: "" only when nothing was transcribed.
     */
    callerSaidWithSource,
    async callerSaid(): Promise<string> {
      return (await callerSaidWithSource()).text;
    },
    get pending(): boolean {
      return outstanding > 0;
    },
  };
}

export type CallerTurnTracker = ReturnType<typeof createCallerTurnTracker>;
