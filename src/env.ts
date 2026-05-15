/**
 * Helpers d'accès aux variables d'environnement.
 *
 * Le worker reçoit ses creds depuis Railway env vars (production) ou
 * `.env.local` à la racine du repo (dev local — chargé par
 * `dotenv` au top de `agent.ts`).
 */

/**
 * Lit une env var, throw si absente. À utiliser pour les valeurs
 * critiques sans lesquelles le worker ne peut pas démarrer (API keys,
 * URLs externes, etc.).
 *
 * @throws si la variable n'est pas définie ou est une string vide.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
}

/**
 * Lit une env var optionnelle, retourne `defaultValue` si absente.
 * Variant non-throw de requireEnv. Pratique pour les overrides facultatifs.
 */
export function envOr(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}
