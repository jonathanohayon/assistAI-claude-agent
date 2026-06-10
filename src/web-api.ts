/**
 * Client HTTP centralisé worker → app web Next.js (APP_URL).
 *
 * Tous les appels du worker vers l'app web passent par ici :
 * `/api/agent/*`, `/api/calls/end`, `/api/events`, `/api/calendar/*`,
 * `/api/sheets/contact`. Centralise :
 *   - la lecture de `APP_URL` + `INTERNAL_SECRET` (erreur claire si absents)
 *   - le header `x-internal-secret` (authentifie le worker auprès du web)
 *   - le `Content-Type: application/json` (POST)
 *   - le timeout via `AbortSignal.timeout`
 *
 * Les helpers renvoient la `Response` brute : chaque call site garde son
 * propre handling de `res.ok` / parse / fallback (failure-open vs
 * best-effort vs retry — voir docs/web-api-contract.md).
 *
 * Exception : `src/region-probe.ts` n'utilise PAS ce module (sonde
 * réseau bas niveau, mesure des RTT vers plusieurs hosts, pas un appel
 * API métier).
 */

interface WebEnv {
  appUrl: string;
  secret: string;
}

// Lazy + caché : dotenv est chargé dans le corps de agent.ts APRÈS
// l'évaluation des imports ESM — une lecture au top-level de ce module
// raterait `.env.local` en dev. On lit donc à la première requête, puis
// on garde le résultat (les env vars ne changent pas en cours de vie).
let cachedEnv: WebEnv | null = null;

function webEnv(): WebEnv {
  if (cachedEnv) return cachedEnv;
  const appUrl = process.env['APP_URL'];
  const secret = process.env['INTERNAL_SECRET'];
  if (!appUrl || !secret) {
    throw new Error(
      "[web-api] APP_URL et/ou INTERNAL_SECRET manquants — impossible de joindre l'app web. " +
        'Vérifier les env vars Railway (ou .env.local en dev).',
    );
  }
  cachedEnv = { appUrl, secret };
  return cachedEnv;
}

export interface WebApiOpts {
  /** Timeout du fetch en ms (défaut 10 000). */
  timeoutMs?: number;
  /** Headers additionnels (ex. routing tenant `x-tenant-phone`). */
  headers?: Record<string, string>;
}

/**
 * POST JSON vers l'app web. `path` commence par `/` (ex. `/api/calls/end`).
 * Renvoie la `Response` — le caller gère `res.ok` lui-même.
 *
 * @throws si APP_URL/INTERNAL_SECRET manquent, si le réseau échoue ou si
 *         le timeout expire (AbortError). Ne throw PAS sur un statut HTTP
 *         d'erreur.
 */
export async function webPost(
  path: string,
  body: unknown,
  opts: WebApiOpts = {},
): Promise<Response> {
  const { appUrl, secret } = webEnv();
  return fetch(`${appUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret,
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
}

/**
 * GET vers l'app web. `path` peut inclure une query string déjà encodée.
 * Renvoie la `Response` — le caller gère `res.ok` lui-même.
 *
 * @throws mêmes cas que `webPost`.
 */
export async function webGet(
  path: string,
  opts: WebApiOpts = {},
): Promise<Response> {
  const { appUrl, secret } = webEnv();
  return fetch(`${appUrl}${path}`, {
    method: 'GET',
    headers: {
      'x-internal-secret': secret,
      ...(opts.headers ?? {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
}
