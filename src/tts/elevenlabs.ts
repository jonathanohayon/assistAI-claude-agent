import type { AudioFrame } from '@livekit/rtc-node';

import { PcmFrameQueue } from './pcm-queue.js';
import {
  type SpeakOptions,
  type TtsEngine,
  type TtsEngineFactory,
} from './types.js';

/**
 * TTS ElevenLabs — modèle par défaut : **Turbo v2.5**.
 *
 * Turbo et non Flash, contre l'ordre habituel, parce que c'est ce que la
 * mesure dit. Depuis europe-west4, TTFB médian :
 *
 *   turbo v2.5 : 622 ms (FR) · 604 ms (HE) — fenêtre 574–627 ms
 *   flash v2.5 : 658 ms (FR) · 673 ms (HE) — fenêtre 622–1551 ms
 *
 * Flash est plus lent ET dispersé : un p95 à 1551 ms est disqualifiant au
 * téléphone, où un tour qui traîne s'entend.
 *
 * Le critère de choix n'est pas la meilleure langue mais **la pire** : Turbo
 * tient 604–622 ms dans les deux, là où OpenAI passe de 456 ms en français à
 * 847 ms en hébreu. Un agent qui change de rythme en changeant de langue
 * paraît hésitant précisément au moment où le multilingue devrait
 * impressionner.
 *
 * Et un seul moteur pour toutes les langues, jamais un routage par langue :
 * la voix changerait au milieu d'un appel quand l'appelant change de langue —
 * ce qui détruirait la fonctionnalité même qu'on met en avant.
 *
 * Ne s'active que si `ELEVENLABS_API_KEY` est présent. `pcm_24000` pour
 * parler le format du pipeline sans resample.
 */

const BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

class ElevenLabsTts implements TtsEngine {
  readonly name = 'elevenlabs';

  async speak(
    text: string,
    options: SpeakOptions,
  ): Promise<ReadableStream<AudioFrame>> {
    const queue = new PcmFrameQueue();
    const controller = new AbortController();
    options.signal?.addEventListener('abort', () => {
      controller.abort();
      queue.cancel();
    });

    // Les tenants sont configurés avec des noms de voix OpenAI (« alloy »,
    // « marin »…), qui ne veulent rien dire ici : ElevenLabs attend un
    // identifiant opaque de 20 caractères. Passer « alloy » tel quel donnerait
    // un 404 à chaque tour, et l'agent serait muet sans que le réglage ait
    // l'air faux. Tant que le catalogue de voix n'est pas unifié, on ne
    // considère comme voiceId que ce qui en a la forme.
    const looksLikeVoiceId = /^[A-Za-z0-9]{20}$/.test(options.voice ?? '');
    const voiceId = looksLikeVoiceId
      ? options.voice
      : (process.env['ELEVENLABS_VOICE_ID'] ?? '');
    if (!voiceId) {
      throw new Error('elevenlabs: aucun voiceId utilisable');
    }
    const url =
      `${BASE}/${encodeURIComponent(voiceId)}/stream` +
      `?output_format=pcm_24000&model_id=${process.env['ELEVENLABS_MODEL'] ?? 'eleven_turbo_v2_5'}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env['ELEVENLABS_API_KEY'] ?? '',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        text,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `elevenlabs tts ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    void (async () => {
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          queue.push(Buffer.from(chunk));
        }
      } catch {
        /* coupure en cours : on ferme, l'appelant décide */
      } finally {
        queue.end();
      }
    })();

    return queue.stream();
  }
}

export const elevenLabsTts: TtsEngineFactory = {
  name: 'elevenlabs',
  available: () => Boolean(process.env['ELEVENLABS_API_KEY']),
  create: () => new ElevenLabsTts(),
};
