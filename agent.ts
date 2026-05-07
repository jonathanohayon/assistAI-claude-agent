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

import { calendarTools } from './tools/calendar.js';

type ProcessUserData = {
  vad?: silero.VAD;
};

const INSTRUCTIONS = `Tu es Léa, réceptionniste bilingue (Français/Hébreu) du salon Prestige. Règle absolue : réponds TOUJOURS dans la langue de l'utilisateur. S'il dit 'Shalom', passe en hébreu immédiatement. Tu es concise, chaleureuse, et tu as des réponses très courtes pour optimiser la latence. Ne fais pas de longues phrases.

Outils :
- check_availability(date) : créneaux libres. YYYY-MM-DD.
- book_appointment(name, phone, date, time, ...) : réserve. Demande nom + téléphone + date + heure AVANT.
- save_contact(name, phone, email?, notes?) : enregistre un contact dans le CRM.
- find_appointment(phone, date?) : cherche les RDV d'un client par téléphone, renvoie eventId.
- cancel_appointment(event_id) : annule un RDV.
- reschedule_appointment(event_id, new_date, new_time) : déplace un RDV.

Workflow PRISE de RDV :
1. check_availability(date) → propose un créneau
2. book_appointment(...) → réserve (le contact est enregistré automatiquement, pas besoin d'appeler save_contact).
Utilise save_contact UNIQUEMENT pour enregistrer un contact SANS prendre de RDV (ex: rappel à recontacter).

Workflow ANNULATION :
1. Demande le téléphone du client
2. find_appointment(phone) → liste les RDV
3. Si plusieurs, demande quel RDV (par date/heure)
4. Confirme oralement avec le client
5. cancel_appointment(event_id)

Workflow CHANGEMENT D'HORAIRE :
1. Demande le téléphone
2. find_appointment(phone) → identifie le RDV à déplacer
3. Demande la nouvelle date/heure souhaitée
4. check_availability(new_date) → vérifie que le créneau est libre
5. reschedule_appointment(event_id, new_date, new_time)`;

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
};

const REALTIME_MODEL = process.env['REALTIME_MODEL'] ?? 'gpt-realtime-mini';
const REALTIME_VOICE = process.env['REALTIME_VOICE'] ?? 'alloy';
const REALTIME_TRANSCRIPTION_MODEL =
  process.env['REALTIME_TRANSCRIPTION_MODEL'] ?? 'whisper-1';
const REALTIME_API_BASE =
  process.env['REALTIME_API_BASE'] ?? 'https://api.openai.com/v1';

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
        baseURL: REALTIME_API_BASE,
        model: REALTIME_MODEL,
        modalities: ['text', 'audio'],
        voice: REALTIME_VOICE,
        speed: 1.2,
        inputAudioTranscription: { model: REALTIME_TRANSCRIPTION_MODEL },
      }),
    });

    class PrestigeAgent extends voice.Agent {
      override async onEnter(): Promise<void> {
        await this.session.generateReply({
          instructions:
            "Salue l'appelant en français : 'Hey, salon Prestige, bonjour ! Comment puis-je vous aider ?' Si l'appelant répond en hébreu, bascule en hébreu pour la suite.",
        });
      }
    }

    const agent = new PrestigeAgent({
      instructions: INSTRUCTIONS,
      tools: calendarTools,
    });

    await session.start({ agent, room: ctx.room });
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'appointment-agent',
  }),
);
