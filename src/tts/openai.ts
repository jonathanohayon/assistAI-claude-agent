import type { AudioFrame } from '@livekit/rtc-node';

import { PcmFrameQueue } from './pcm-queue.js';
import {
  PCM_SAMPLE_RATE,
  type SpeakOptions,
  type TtsEngine,
  type TtsEngineFactory,
} from './types.js';

/**
 * TTS OpenAI (`/v1/audio/speech`).
 *
 * Driver par défaut, et c'est un choix assumé : il règle le verbatim aussi
 * bien qu'un moteur spécialisé, il streame du PCM, et il n'ajoute **ni
 * fournisseur, ni clé, ni facture** — le compte OpenAI est déjà là. Le seul
 * terrain où un moteur spécialisé peut le battre est la qualité de voix, et
 * cela s'écoute plutôt que cela ne se déduit : d'où l'interface.
 *
 * `response_format: 'pcm'` renvoie du PCM16 mono 24 kHz — exactement le format
 * du pipeline, donc aucun resample.
 */

const ENDPOINT = 'https://api.openai.com/v1/audio/speech';

/** Voix Realtime → voix TTS. Les tenants sont configurés avec les premières. */
const VOICE_MAP: Record<string, string> = {
  marin: 'alloy',
  cedar: 'onyx',
  coral: 'coral',
  sage: 'sage',
  alloy: 'alloy',
  ballad: 'ballad',
};

class OpenAiTts implements TtsEngine {
  readonly name = 'openai';

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

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env['OPENAI_API_KEY']}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env['TTS_MODEL'] ?? 'gpt-4o-mini-tts',
        input: text,
        voice: VOICE_MAP[options.voice] ?? 'alloy',
        response_format: 'pcm',
        ...(options.speed ? { speed: options.speed } : {}),
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `openai tts ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    // On ne bloque pas sur le corps : les frames partent dès les premiers
    // octets, et c'est tout l'intérêt du streaming.
    void (async () => {
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          queue.push(Buffer.from(chunk));
        }
      } catch {
        // Coupure en cours de synthèse : on ferme proprement, l'appelant
        // décidera. Ne jamais throw ici, personne ne l'attraperait.
      } finally {
        queue.end();
      }
    })();

    return queue.stream();
  }
}

export const openAiTts: TtsEngineFactory = {
  name: 'openai',
  available: () => Boolean(process.env['OPENAI_API_KEY']),
  create: () => new OpenAiTts(),
};

export { PCM_SAMPLE_RATE };
