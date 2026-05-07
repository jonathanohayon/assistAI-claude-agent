import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

// Single source of truth: load the project's .env.local from the repo root.
// Must run before any module reads process.env (calendarTools, openai, etc.).
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
  GREETING_INSTRUCTIONS,
  INSTRUCTIONS,
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

export default defineAgent<ProcessUserData>({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext<ProcessUserData>) => {
    const apiKey = process.env['REALTIME_API_KEY'] ?? requireEnv('OPENAI_API_KEY');
    const vad = ctx.proc.userData.vad;
    if (!vad) throw new Error('Silero VAD non préchargé.');

    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);

    const session = new voice.AgentSession({
      vad,
      llm: new openai.realtime.RealtimeModel({
        apiKey,
        baseURL: REALTIME_CONFIG.apiBase,
        model: REALTIME_CONFIG.model,
        modalities: [...REALTIME_CONFIG.modalities],
        voice: REALTIME_CONFIG.voice,
        temperature: REALTIME_CONFIG.temperature,
        speed: REALTIME_CONFIG.speed,
        inputAudioTranscription: {
          model: REALTIME_CONFIG.transcriptionModel,
        },
      }),
    });

    class JohanaAgent extends voice.Agent {
      override async onEnter(): Promise<void> {
        await this.session.generateReply({
          instructions: GREETING_INSTRUCTIONS,
        });
      }
    }

    const agent = new JohanaAgent({
      instructions: INSTRUCTIONS,
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
