import { AudioFrame } from '@livekit/rtc-node';

import { PCM_SAMPLE_RATE } from './types.js';

/**
 * File d'octets PCM → flux d'AudioFrames, alimentée au fil de l'eau.
 *
 * `pcmToFrameStream` (greeting-player) découpe un buffer déjà complet ; ici les
 * octets arrivent par morceaux pendant la synthèse, et deux détails comptent :
 *
 *   - **Le carry.** Un chunk réseau peut couper un échantillon Int16 en deux.
 *     On accumule donc les octets et on ne compose une frame que lorsqu'on en
 *     a assez ; l'octet orphelin attend le chunk suivant.
 *   - **Le pull.** Le flux est tiré par le SDK au rythme du playout. Aucune
 *     temporisation ici : le pacing vient de la consommation, pas d'un timer.
 */

const SAMPLES_PER_FRAME = Math.floor(PCM_SAMPLE_RATE * 0.02); // 20 ms
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;

export class PcmFrameQueue {
  private chunks: Buffer[] = [];
  private pending = 0;
  private finished = false;
  private cancelled = false;
  private wake: (() => void) | null = null;

  push(chunk: Buffer): void {
    if (this.cancelled || this.finished) return;
    this.chunks.push(chunk);
    this.pending += chunk.length;
    this.release();
  }

  /** Plus d'octets à venir : le flux se fermera une fois la file vidée. */
  end(): void {
    this.finished = true;
    this.release();
  }

  /** Barge-in : on jette ce qui reste et on ferme immédiatement. */
  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
    this.pending = 0;
    this.release();
  }

  /** Octets déjà remis au SDK — sert à estimer ce qui a réellement été dit. */
  private delivered = 0;
  get deliveredMs(): number {
    return Math.round((this.delivered / 2 / PCM_SAMPLE_RATE) * 1000);
  }

  /** Débloque un `pull` en attente. Toujours appelé après un changement d'état. */
  private release(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private take(bytes: number): Buffer {
    const out = Buffer.allocUnsafe(bytes);
    let filled = 0;
    while (filled < bytes) {
      const head = this.chunks[0]!;
      const need = bytes - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.pending -= bytes;
    this.delivered += bytes;
    return out;
  }

  stream(): ReadableStream<AudioFrame> {
    return new ReadableStream<AudioFrame>({
      pull: async (controller) => {
        // Attendre d'avoir une frame entière, sauf si la source est terminée.
        while (this.pending < BYTES_PER_FRAME && !this.finished && !this.cancelled) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
        }

        if (this.cancelled) {
          controller.close();
          return;
        }

        // Frame finale possiblement partielle — alignée sur un Int16 entier.
        const available = Math.min(this.pending, BYTES_PER_FRAME);
        const bytes = available - (available % 2);
        if (bytes === 0) {
          controller.close();
          return;
        }

        const buf = this.take(bytes);
        const samples = bytes / 2;
        const i16 = new Int16Array(samples);
        for (let i = 0; i < samples; i++) i16[i] = buf.readInt16LE(i * 2);
        controller.enqueue(new AudioFrame(i16, PCM_SAMPLE_RATE, 1, samples));

        if (this.finished && this.pending < 2) controller.close();
      },
      cancel: () => this.cancel(),
    });
  }
}
