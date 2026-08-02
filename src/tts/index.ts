import { elevenLabsTts } from './elevenlabs.js';
import { openAiTts } from './openai.js';
import type { TtsEngine, TtsEngineFactory } from './types.js';

export * from './types.js';
export { PcmFrameQueue } from './pcm-queue.js';

/**
 * Sélection du moteur TTS.
 *
 * Un seul moteur sert toutes les langues d'un appel. `TTS_ENGINE` permet de
 * basculer pour comparer — c'est la seule façon honnête de trancher, comme
 * l'a montré l'écart entre les latences annoncées et les latences mesurées.
 *
 * Un moteur demandé mais non configuré ne fait pas échouer l'appel : on
 * retombe sur le premier moteur disponible en le disant dans les logs. Une
 * variable d'environnement oubliée ne doit pas rendre un agent muet.
 */

// Ordre = préférence par défaut. ElevenLabs Turbo d'abord : mesuré à
// 604–622 ms dans les deux langues contre 456/847 ms pour OpenAI, dont la
// dispersion (366–975 ms) s'entend au téléphone. OpenAI reste le repli
// quand aucune clé ElevenLabs n'est configurée — il n'ajoute aucun
// fournisseur et le compte est déjà là.
const FACTORIES: TtsEngineFactory[] = [elevenLabsTts, openAiTts];

let cached: TtsEngine | null = null;

export function getTtsEngine(): TtsEngine | null {
  if (cached) return cached;

  const wanted = process.env['TTS_ENGINE'];
  if (wanted) {
    const match = FACTORIES.find((f) => f.name === wanted);
    if (match?.available()) {
      cached = match.create();
      console.log(`[tts] moteur : ${cached.name}`);
      return cached;
    }
    console.warn(
      `[tts] moteur « ${wanted} » demandé mais indisponible — repli sur le premier configuré`,
    );
  }

  const fallback = FACTORIES.find((f) => f.available());
  if (!fallback) {
    console.warn('[tts] aucun moteur configuré');
    return null;
  }
  cached = fallback.create();
  console.log(`[tts] moteur : ${cached.name}`);
  return cached;
}

/** Pour les tests : oublie le moteur mémorisé. */
export function resetTtsEngine(): void {
  cached = null;
}
