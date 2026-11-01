/**
 * Realtime session teardown at job shutdown.
 *
 * The OpenAI plugin's RealtimeSession reconnects in `while (!closed)`: if its
 * own close() is never called, it reconnects forever, including after
 * OpenAI's server-side session cap. Suspected cause of the 24–25/10/2026
 * incident: ~8,900 error events/hour for 25 h with NO call in progress, each
 * carrying the origin of the last call (31/08), the day the key died.
 *
 * So: on job shutdown, close the session explicitly (harmless if already
 * closed) with a bounded wait, and flag any server event that still arrives
 * after shutdown, which would mean a WebSocket survived the call.
 */

export interface ClosableSession {
  close(): Promise<void>;
}

/** Closes with a timeout: a hung close must not block job teardown. */
export async function closeWithTimeout(
  session: ClosableSession | null,
  timeoutMs: number,
): Promise<'closed' | 'timeout' | 'none' | 'error'> {
  if (!session) return 'none';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.close().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Watches server events against the job lifecycle. `onEvent` returns true
 * exactly once: for the first event received after shutdown (a zombie).
 */
export function createZombieWatch(now: () => number = Date.now) {
  let shutDownAt: number | null = null;
  let lastEventAt: number | null = null;
  let reported = false;
  return {
    onEvent(): boolean {
      lastEventAt = now();
      if (shutDownAt === null || reported) return false;
      reported = true;
      return true;
    },
    markShutdown(): { lastEventAgoMs: number | null } {
      shutDownAt = now();
      return { lastEventAgoMs: lastEventAt === null ? null : shutDownAt - lastEventAt };
    },
  };
}
