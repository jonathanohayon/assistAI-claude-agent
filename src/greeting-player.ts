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
 * retombe alors sur l'accueil modèle).
 *
 * The timeout covers the whole response, body included (~400 KB of PCM via
 * the public domain). 600 ms was too short on LiveKit 1.9.5: on 03/11 the web
 * served the opener in 66 ms, yet the worker fell back to a 5.4 s model
 * greeting. The fetch starts at job entry and runs in parallel with the
 * session setup (~1 s), so a longer budget doesn't delay the call.
 * One [opener] log line per call records the outcome (never the audio).
 */
export const OPENER_TIMEOUT_MS = 2_500;

export async function fetchOpenerPcm(
  phone: string,
  timeoutMs = OPENER_TIMEOUT_MS,
): Promise<OpenerAudio | null> {
  const t0 = Date.now();
  const done = (result: OpenerAudio | null, detail: string) => {
    console.log(`[opener] ${detail} in ${Date.now() - t0} ms`);
    return result;
  };
  try {
    const res = await webGet(
      `/api/agent/greeting-audio?phone=${encodeURIComponent(phone)}`,
      { timeoutMs },
    );
    if (res.status !== 200) return done(null, `status ${res.status}, model greeting`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return done(null, 'empty body, model greeting');
    const sampleRate = Number(res.headers.get('x-sample-rate') ?? '24000');
    const textB64 = res.headers.get('x-opener-text') ?? '';
    const text = textB64
      ? Buffer.from(textB64, 'base64').toString('utf8')
      : '';
    return done({ pcm: buf, sampleRate, text }, `ok ${buf.length} bytes`);
  } catch (e) {
    return done(null, `failed (${(e as Error)?.name ?? 'error'}), model greeting`);
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
