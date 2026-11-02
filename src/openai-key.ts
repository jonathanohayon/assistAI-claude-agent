/**
 * Single source for the OpenAI key used by Realtime and TTS.
 *
 * The worker used to prefer REALTIME_API_KEY over OPENAI_API_KEY. In
 * production REALTIME_API_KEY still held a revoked key after OPENAI_API_KEY
 * was rotated, so every call died with invalid_api_key while the new key sat
 * unused. Only OPENAI_API_KEY is read now; a leftover REALTIME_API_KEY is
 * ignored and reported by name (never by value) at boot.
 */
export type OpenAiKeyResolution = {
  key: string;
  source: 'OPENAI_API_KEY';
  ignored: string[];
};

const IGNORED_KEYS = ['REALTIME_API_KEY'];

export function resolveOpenAiKey(env: NodeJS.ProcessEnv = process.env): OpenAiKeyResolution {
  const key = env['OPENAI_API_KEY'];
  if (!key) throw new Error('Missing environment variable: OPENAI_API_KEY');
  const ignored = IGNORED_KEYS.filter((name) => Boolean(env[name]));
  return { key, source: 'OPENAI_API_KEY', ignored };
}

/** Boot log line: names only, never values. */
export function describeOpenAiKey(r: OpenAiKeyResolution): string {
  const tail = r.ignored.length ? ` (ignored, remove from env: ${r.ignored.join(', ')})` : '';
  return `[openai-key] source=${r.source}${tail}`;
}
