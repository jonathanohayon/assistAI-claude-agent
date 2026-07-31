import type { AudioFrame } from '@livekit/rtc-node';

/**
 * Couche TTS interchangeable.
 *
 * Raison d'être : en mode BYO-agent, le texte vient du client et doit être
 * prononcé **mot pour mot**. Le passer par `generateReply({ instructions:
 * "dis exactement ceci" })` laisse un modèle génératif libre de reformuler —
 * et les reformulations tombent précisément là où c'est inacceptable : prix,
 * numéros, mentions légales. Un TTS prononce le texte, point.
 *
 * L'abstraction n'est pas de la sur-ingénierie : le choix du fournisseur se
 * joue à l'oreille, langue par langue, et cette oreille n'a pas encore
 * tranché. Un driver s'écrit en une centaine de lignes ; une dépendance dure
 * à un fournisseur se paie pendant des années — et se remarque en due
 * diligence.
 */

/** PCM16 mono little-endian. Tout le pipeline audio du worker parle ce format. */
export const PCM_SAMPLE_RATE = 24_000;

export interface SpeakOptions {
  /** Voix côté fournisseur (« marin », « alloy », un voiceId ElevenLabs…). */
  voice: string;
  /** Langue du texte — certains moteurs en ont besoin, d'autres l'ignorent. */
  language?: string;
  /** Débit relatif, 0.5–1.5. Les moteurs qui ne savent pas faire l'ignorent. */
  speed?: number;
  /** Coupe la synthèse en cours (barge-in). */
  signal?: AbortSignal;
}

export interface TtsEngine {
  /** Identifiant court, pour les logs et les métriques. */
  readonly name: string;

  /**
   * Synthétise `text` et renvoie un flux d'AudioFrames prêt pour
   * `session.say(text, { audio })`.
   *
   * Contrat :
   *   - Le flux émet des frames de 20 ms à PCM_SAMPLE_RATE, mono.
   *   - Il est *pull-based* : le SDK tire au rythme du playout, aucun `sleep`
   *     ici — c'est lui qui applique la backpressure.
   *   - `signal.abort()` doit fermer le flux en moins de ~100 ms.
   *   - Ne throw jamais après le premier octet : une panne en cours de
   *     synthèse ferme le flux, et l'appelant décide quoi faire.
   */
  speak(text: string, options: SpeakOptions): Promise<ReadableStream<AudioFrame>>;
}

/** Un moteur indisponible (clé absente, quota) se déclare plutôt que d'échouer à l'appel. */
export interface TtsEngineFactory {
  readonly name: string;
  /** false si la configuration nécessaire manque — on ne le proposera pas. */
  available(): boolean;
  create(): TtsEngine;
}
