// Accueil instantané : récupère l'opener pré-généré (PCM16 mono) depuis le web
// et le convertit en flux d'AudioFrames pour `session.say({ audio })`.
//
// API LiveKit utilisée (vérifiée @livekit/agents 1.4) :
//   session.say(text, { audio: ReadableStream<AudioFrame>, addToChatCtx })
//     → joue l'audio comme voix de l'agent (piste de sortie unique), et ajoute
//       `text` au chatCtx (le modèle sait qu'il a déjà accueilli).
//   session.input.setAudioEnabled(false/true) → gèle la VAD pendant la lecture.
// AudioSource resample automatiquement si la track est à un autre sample rate.

import { AudioFrame } from '@livekit/rtc-node';

import { webGet } from './web-api.js';

export type OpenerAudio = { pcm: Buffer; sampleRate: number; text: string };

/**
 * Fetch l'opener pré-généré. Renvoie null si 204 / erreur / timeout (le worker
 * retombe alors sur l'accueil modèle). Timeout court : ne jamais retarder l'appel.
 * APP_URL + x-internal-secret gérés par `webGet` (cf. src/web-api.ts).
 */
export async function fetchOpenerPcm(
  phone: string,
  timeoutMs = 600,
): Promise<OpenerAudio | null> {
  try {
    const res = await webGet(
      `/api/agent/greeting-audio?phone=${encodeURIComponent(phone)}`,
      { timeoutMs },
    );
    if (res.status !== 200) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    const sampleRate = Number(res.headers.get('x-sample-rate') ?? '24000');
    const textB64 = res.headers.get('x-opener-text') ?? '';
    const text = textB64
      ? Buffer.from(textB64, 'base64').toString('utf8')
      : '';
    return { pcm: buf, sampleRate, text };
  } catch {
    return null;
  }
}

/** Découpe un PCM16 mono en frames de 20ms → ReadableStream pour session.say. */
export function pcmToFrameStream(
  pcm: Buffer,
  sampleRate: number,
): ReadableStream<AudioFrame> {
  const samplesPerFrame = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms
  const bytesPerFrame = samplesPerFrame * 2;
  let off = 0;
  const frameAt = (start: number, samples: number): AudioFrame => {
    const i16 = new Int16Array(samples);
    for (let i = 0; i < samples; i++) i16[i] = pcm.readInt16LE(start + i * 2);
    return new AudioFrame(i16, sampleRate, 1, samples);
  };
  return new ReadableStream<AudioFrame>({
    pull(controller) {
      if (off + bytesPerFrame <= pcm.length) {
        controller.enqueue(frameAt(off, samplesPerFrame));
        off += bytesPerFrame;
        return;
      }
      // dernière frame partielle
      const remBytes = pcm.length - off;
      if (remBytes >= 2) {
        const samples = Math.floor(remBytes / 2);
        controller.enqueue(frameAt(off, samples));
      }
      off = pcm.length;
      controller.close();
    },
  });
}
