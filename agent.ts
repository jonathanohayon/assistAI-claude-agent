import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

// Single source of truth: load the project's .env.local from the repo root.
// Must run before any module reads process.env.
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

// Fetch the runtime config from the web service. This is what makes the
// dashboard live: editing in /dashboard updates DB, next call picks it up.
// Fallback to compiled-in defaults if the web service is unreachable so the
// agent never goes silent in a dependency outage.
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
      greetingInstructions:
        data.greetingInstructions ?? FALLBACK_GREETING,
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
