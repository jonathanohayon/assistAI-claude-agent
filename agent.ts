import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

// Single source of truth: load the project's .env.local from the repo root.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'),
});

import {
  AutoSubscribe,
  type JobContext,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { RoomEvent } from '@livekit/rtc-node';

import {
  AGENT_NAME,
  GREETING_INSTRUCTIONS as FALLBACK_GREETING,
  INSTRUCTIONS as FALLBACK_INSTRUCTIONS,
  REALTIME_CONFIG,
} from './config.js';
import { calendarTools } from './tools/calendar.js';

type ProcessUserData = {
  vad?: silero.VAD;
};

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
};

interface FetchedConfig {
  instructions: string;
  greetingInstructions: string;
  model: string;
  voice: string;
  temperature: number;
  speed: number;
  maxResponseTokens: number;
}

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

const fetchConfig = async (): Promise<FetchedConfig> => {
  const appUrl = process.env['APP_URL'];
  if (!appUrl) {
    console.warn('[config] APP_URL not set, using compiled defaults');
    return defaultConfig();
  }
  try {
    const res = await fetch(`${appUrl}/api/agent/config`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[config] /api/agent/config → ${res.status}, using defaults`);
      return defaultConfig();
    }
    const data = (await res.json()) as Partial<FetchedConfig>;
    return {
      instructions: data.instructions ?? FALLBACK_INSTRUCTIONS,
      greetingInstructions: data.greetingInstructions ?? FALLBACK_GREETING,
      model: data.model ?? REALTIME_CONFIG.model,
      voice: data.voice ?? REALTIME_CONFIG.voice,
      temperature: data.temperature ?? REALTIME_CONFIG.temperature,
      speed: data.speed ?? REALTIME_CONFIG.speed,
      maxResponseTokens: data.maxResponseTokens ?? 220,
    };
  } catch (e) {
    console.warn(`[config] fetch failed (${(e as Error).message}), using defaults`);
    return defaultConfig();
  }
};

const defaultConfig = (): FetchedConfig => ({
  instructions: FALLBACK_INSTRUCTIONS,
  greetingInstructions: FALLBACK_GREETING,
  model: REALTIME_CONFIG.model,
  voice: REALTIME_CONFIG.voice,
  temperature: REALTIME_CONFIG.temperature,
  speed: REALTIME_CONFIG.speed,
  maxResponseTokens: 220,
});

// POST the recorded transcript + caller's phone to the web service so it can
// summarize and dispatch WhatsApp messages. Best-effort: never throws so a
// post-call failure can't crash the agent.
const postCallEnd = async (transcript: TranscriptEntry[], fromNumber: string) => {
  const appUrl = process.env['APP_URL'];
  const secret = process.env['INTERNAL_SECRET'];
  if (!appUrl || !secret) {
    console.warn('[recap] APP_URL or INTERNAL_SECRET missing — skipping recap');
    return;
  }
  if (transcript.length === 0) {
    console.log('[recap] empty transcript — skipping');
    return;
  }
  try {
    const res = await fetch(`${appUrl}/api/calls/end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({ fromNumber, transcript }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    console.log(`[recap] /api/calls/end → ${res.status} ${body.slice(0, 200)}`);
  } catch (e) {
    console.error(`[recap] failed: ${(e as Error).message}`);
  }
};

// SIP participants in LiveKit have identity `sip_+972585001007`.
const phoneFromSipIdentity = (identity: string): string =>
  identity.startsWith('sip_') ? identity.slice(4) : '';

export default defineAgent<ProcessUserData>({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext<ProcessUserData>) => {
    const apiKey = process.env['REALTIME_API_KEY'] ?? requireEnv('OPENAI_API_KEY');
    const vad = ctx.proc.userData.vad;
    if (!vad) throw new Error('Silero VAD non préchargé.');

    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);

    const cfg = await fetchConfig();
    console.log(
      `[config] using model=${cfg.model} voice=${cfg.voice} temp=${cfg.temperature}`,
    );

    const session = new voice.AgentSession({
      vad,
      llm: new openai.realtime.RealtimeModel({
        apiKey,
        baseURL: REALTIME_CONFIG.apiBase,
        model: cfg.model,
        modalities: [...REALTIME_CONFIG.modalities],
        voice: cfg.voice,
        temperature: cfg.temperature,
        speed: cfg.speed,
        inputAudioTranscription: {
          model: REALTIME_CONFIG.transcriptionModel,
        },
      }),
    });

    // ── Transcript capture ──────────────────────────────────────────────
    const transcript: TranscriptEntry[] = [];
    let fromNumber = '';
    let recapSent = false;

    // Pull the SIP caller's number from the connected participant.
    for (const [, p] of ctx.room.remoteParticipants) {
      const num = phoneFromSipIdentity(p.identity);
      if (num) fromNumber = num;
    }
    ctx.room.on(RoomEvent.ParticipantConnected, (p) => {
      const num = phoneFromSipIdentity(p.identity);
      if (num) fromNumber = num;
    });

    // Grab final user transcripts as they come in.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const text = (ev.transcript ?? '').trim();
      if (text) transcript.push({ role: 'user', text });
    });

    // Grab assistant messages once committed to the chat history.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item as {
        type?: string;
        role?: string;
        content?: Array<unknown>;
      };
      if (item?.type !== 'message' || item.role !== 'assistant') return;
      const text = (item.content ?? [])
        .map((c) => (typeof c === 'string' ? c : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) transcript.push({ role: 'assistant', text });
    });

    // ── End-of-call recap ───────────────────────────────────────────────
    const triggerRecap = async () => {
      if (recapSent) return;
      recapSent = true;
      await postCallEnd(transcript, fromNumber);
    };

    ctx.room.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (phoneFromSipIdentity(p.identity)) {
        // Caller hung up. Fire-and-await — the worker stays alive long enough.
        void triggerRecap();
      }
    });
    ctx.room.on(RoomEvent.Disconnected, () => {
      void triggerRecap();
    });

    class JohanaAgent extends voice.Agent {
      override async onEnter(): Promise<void> {
        await this.session.generateReply({
          instructions: cfg.greetingInstructions,
        });
      }
    }

    const agent = new JohanaAgent({
      instructions: cfg.instructions,
      tools: calendarTools,
    });

    await session.start({ agent, room: ctx.room });
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
  }),
);
