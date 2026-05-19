/**
 * Helper de logging distant — POST sur `/api/events` côté web.
 *
 * Les events apparaissent ensuite dans `/dashboard/logs` (UI tenant
 * pour ses propres events) et `/admin` (admin voit tout).
 *
 * Best-effort : ne throw jamais. Si le fetch échoue, on log juste
 * localement sur stdout (visible dans Railway logs du worker).
 *
 * Context-aware : utilise un AsyncLocalStorage pour propager `origin`
 * (resolved par detectOrigin au début de entry()) à TOUS les remoteLog
 * appelés dans le scope d'une session — sans avoir à passer origin
 * explicitement à chaque appel. Permet à lib/logger.ts côté web de
 * résoudre user_id même sur les events qui ne portent pas naturellement
 * de toNumber (config_loaded, auto_hangup, realtime_server_error, etc.)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { REMOTE_LOG_TIMEOUT_MS } from './constants.js';

type LogLevel = 'info' | 'warn' | 'error';

interface SessionContext {
  origin?: {
    kind?: 'sip' | 'web' | 'unknown';
    userId?: string;
    calledNumber?: string;
  };
}

const sessionContext = new AsyncLocalStorage<SessionContext>();

/**
 * Wrap une session worker pour propager `origin` à tous les remoteLog
 * appelés à l'intérieur. À appeler dans entry() une fois origin connu :
 *   await runWithSession({ origin }, async () => { ... rest of entry() ... });
 */
export function runWithSession<T>(
  ctx: SessionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return sessionContext.run(ctx, fn);
}

/**
 * Variante sans callback : set le context pour la suite de la chaîne
 * async courante. Plus pratique que `run()` quand on veut juste enrichir
 * entry() en cours sans tout réécrire dans un closure.
 */
export function enterSession(ctx: SessionContext): void {
  sessionContext.enterWith(ctx);
}

/**
 * Push un event structuré au log central.
 *
 * @param source    Module qui log (ex. "agent", "tenant", "summary")
 * @param event     Nom court de l'event (ex. "call_started", "config_loaded")
 * @param message   Message lisible humain
 * @param level     Niveau (info par défaut)
 * @param metadata  Données structurées additionnelles (sérialisées en JSON)
 */
export async function remoteLog(
  source: string,
  event: string,
  message: string,
  level: LogLevel = 'info',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // Auto-inject origin depuis le SessionContext si l'event n'en porte pas
  // déjà un. Permet à lib/logger.ts côté web de résoudre user_id pour les
  // events worker comme config_loaded, auto_hangup, etc. qui n'ont
  // historiquement aucun champ permettant la résolution.
  const ctx = sessionContext.getStore();
  const finalMetadata =
    ctx?.origin && metadata['origin'] === undefined
      ? { ...metadata, origin: ctx.origin }
      : metadata;

  // Toujours mirror localement pour qu'on voie les logs même si l'API
  // distante est down. Format compact pour lisibilité dans Railway logs.
  console.log(`[${source}:${event}]`, message, finalMetadata);

  const appUrl = process.env['APP_URL'];
  const secret = process.env['INTERNAL_SECRET'];
  if (!appUrl || !secret) return;

  try {
    await fetch(`${appUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({ source, event, message, level, metadata: finalMetadata }),
      signal: AbortSignal.timeout(REMOTE_LOG_TIMEOUT_MS),
    });
  } catch {
    // Logging distant est best-effort. Failures ne doivent jamais
    // crasher la session. Le mirror stdout au-dessus garantit qu'on
    // garde une trace locale dans tous les cas.
  }
}
