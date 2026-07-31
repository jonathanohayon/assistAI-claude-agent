import { elevenLabsTts } from './elevenlabs.js';
import { openAiTts } from './openai.js';
import type { TtsEngine, TtsEngineFactory } from './types.js';

export * from './types.js';
export { PcmFrameQueue } from './pcm-queue.js';

/**
 * Sélection du moteur TTS.
 *
 * OpenAI est le défaut délibéré : il n'ajoute ni fournisseur ni facture, et il
 * règle le verbatim aussi bien qu'un moteur spécialisé. `TTS_ENGINE` permet de
 * basculer pour comparer — c'est la seule façon honnête de trancher une
 * question de qualité de voix.
 *
 * Un moteur demandé mais non configuré ne fait pas échouer l'appel : on
 * retombe sur le premier moteur disponible en le disant dans les logs. Une
 * variable d'environnement oubliée ne doit pas rendre un agent muet.
 */

const FACTORIES: TtsEngineFactory[] = [openAiTts, elevenLabsTts];

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
