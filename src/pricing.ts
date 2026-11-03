/**
 * Coût USD d'un appel Realtime à partir des tokens consommés.
 *
 * Le prix dominant d'un appel vocal = les tokens AUDIO (input/output), bien
 * plus chers que le texte. Les instructions (texte) sont surtout en cache
 * après le 1er tour → facturées au tarif cached. On calcule donc à partir du
 * breakdown audio/texte/cached, pas d'un total agrégé.
 *
 * Tarifs en USD par 1M de tokens. Source : OpenAI API pricing (2026-06).
 * - gpt-realtime-2 : EXACT (doc officielle).
 * - gpt-realtime-2.1 : EXACT (pricing page, same as -2). 2.1-mini : model page only.
 * - gpt-realtime-1.5 : aligné sur -2 tant que pas de tarif distinct publié.
 * - gpt-realtime-mini : ESTIMÉ (~60% moins cher que la base, doc non chiffrée).
 * À ajuster ici si OpenAI publie/modifie les tarifs (un seul endroit).
 */

export interface RealtimeRates {
  audioIn: number;
  audioOut: number;
  textIn: number;
  textOut: number;
  cachedIn: number; // tarif unique cached (audio comme texte) chez OpenAI
}

const RATES: Record<string, RealtimeRates> = {
  'gpt-realtime-2': { audioIn: 32, audioOut: 64, textIn: 4, textOut: 24, cachedIn: 0.4 },
  // Admin-only engine option. https://developers.openai.com/api/docs/pricing
  // (2026-11-01): same rates as gpt-realtime-2.
  'gpt-realtime-2.1': { audioIn: 32, audioOut: 64, textIn: 4, textOut: 24, cachedIn: 0.4 },
  // UNVERIFIED on the pricing page (not listed there on 2026-11-03); from
  // https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini.
  // Audio cached 0.30 / text cached 0.06: we keep one cached rate, the audio one.
  'gpt-realtime-2.1-mini': { audioIn: 10, audioOut: 20, textIn: 0.6, textOut: 2.4, cachedIn: 0.3 },
  'gpt-realtime-1.5': { audioIn: 32, audioOut: 64, textIn: 4, textOut: 24, cachedIn: 0.4 },
  'gpt-realtime-mini': { audioIn: 12.8, audioOut: 25.6, textIn: 1.6, textOut: 9.6, cachedIn: 0.16 },
};

const DEFAULT_RATES = RATES['gpt-realtime-2']!;

export interface TokenBuckets {
  inAudio: number; // total tokens audio en input (cached inclus)
  inText: number; // total tokens texte en input (cached inclus)
  inCachedAudio: number; // sous-ensemble audio en cache
  inCachedText: number; // sous-ensemble texte en cache
  outAudio: number;
  outText: number;
}

/**
 * Coût total USD de l'appel. Les tokens cached sont facturés au tarif cached
 * ($0.40/1M) et soustraits du volume plein tarif. Si le split cached
 * audio/texte est inconnu, l'appelant met tout dans `inCachedText` (le cache
 * Realtime porte essentiellement sur le prompt = texte).
 */
export function computeRealtimeCostUsd(b: TokenBuckets, model: string): number {
  const r = RATES[model] ?? DEFAULT_RATES;
  const cachedTotal = b.inCachedAudio + b.inCachedText;
  const nonCachedAudioIn = Math.max(0, b.inAudio - b.inCachedAudio);
  const nonCachedTextIn = Math.max(0, b.inText - b.inCachedText);
  const usd =
    (nonCachedAudioIn * r.audioIn +
      nonCachedTextIn * r.textIn +
      cachedTotal * r.cachedIn +
      b.outAudio * r.audioOut +
      b.outText * r.textOut) /
    1_000_000;
  return usd;
}
