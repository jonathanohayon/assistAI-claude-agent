/**
 * Helper de logging distant — POST sur `/api/events` côté web.
 *
 * Les events apparaissent ensuite dans `/dashboard/logs` (UI tenant
 * pour ses propres events) et `/admin` (admin voit tout).
 *
 * Best-effort : ne throw jamais. Si le fetch échoue, on log juste
 * localement sur stdout (visible dans Railway logs du worker).
 */

import { REMOTE_LOG_TIMEOUT_MS } from './constants.js';

type LogLevel = 'info' | 'warn' | 'error';

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
  // Toujours mirror localement pour qu'on voie les logs même si l'API
  // distante est down. Format compact pour lisibilité dans Railway logs.
  console.log(`[${source}:${event}]`, message, metadata);

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
      body: JSON.stringify({ source, event, message, level, metadata }),
      signal: AbortSignal.timeout(REMOTE_LOG_TIMEOUT_MS),
    });
  } catch {
    // Logging distant est best-effort. Failures ne doivent jamais
    // crasher la session. Le mirror stdout au-dessus garantit qu'on
    // garde une trace locale dans tous les cas.
  }
}
