import type { AudioFrame } from '@livekit/rtc-node';

import { PcmFrameQueue } from './pcm-queue.js';
import {
  type SpeakOptions,
  type TtsEngine,
  type TtsEngineFactory,
} from './types.js';

/**
 * TTS ElevenLabs (Flash v2.5).
 *
 * Second driver, présent pour être comparé — pas pour être adopté d'office.
 * Son intérêt supposé est la qualité de voix, en particulier en hébreu, mais
 * c'est un jugement d'oreille : ce driver existe pour que la comparaison se
 * fasse sur des échantillons réels plutôt que sur des fiches produit.
 *
 * Ne s'active que si `ELEVENLABS_API_KEY` est présent. Sans clé, la fabrique
 * se déclare indisponible et le sélecteur ne la propose jamais.
 *
 * On demande `output_format=pcm_24000` pour parler le format du pipeline
 * directement, sans resample.
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

    // La voix du tenant est un voiceId ElevenLabs quand ce driver est actif ;
    // sinon on retombe sur la voix par défaut du compte.
    const voiceId = options.voice || process.env['ELEVENLABS_VOICE_ID'] || '';
    const url =
      `${BASE}/${encodeURIComponent(voiceId)}/stream` +
      `?output_format=pcm_24000&model_id=${process.env['ELEVENLABS_MODEL'] ?? 'eleven_flash_v2_5'}`;

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
