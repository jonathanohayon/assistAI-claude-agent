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
  llm,
  voice,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { RoomEvent } from '@livekit/rtc-node';
import { z } from 'zod';

import {
  AGENT_NAME,
  GREETING_INSTRUCTIONS as FALLBACK_GREETING,
  INSTRUCTIONS as FALLBACK_INSTRUCTIONS,
  REALTIME_CONFIG,
} from './config.js';
import { calendarTools } from './tools/calendar.js';

// Inactivity threshold before the agent hangs up by itself.
// 30s = enough for a customer to think mid-conversation without us cutting
// them off, but short enough that a stale call doesn't linger forever.
// Override via SILENCE_HANGUP_MS env var.
const SILENCE_HANGUP_MS = Number(process.env['SILENCE_HANGUP_MS'] ?? 30_000);
// Delay between an LLM-triggered end_call and the actual close, to let the
// agent's goodbye audio finish playing on the caller's side.
const END_CALL_GRACE_MS = 1_500;
// Grace period at the start of the call before the silence watchdog kicks
// in. The customer might pause briefly after the greeting; we don't want to
// pre-empt them.
const SILENCE_GRACE_START_MS = 10_000;

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

const fetchConfig = async (calledNumber: string): Promise<FetchedConfig> => {
  const appUrl = process.env['APP_URL'];
  if (!appUrl) {
    console.warn('[config] APP_URL not set, using compiled defaults');
    return defaultConfig();
  }
  try {
    const url = calledNumber
      ? `${appUrl}/api/agent/config?phone=${encodeURIComponent(calledNumber)}`
      : `${appUrl}/api/agent/config`;
    const res = await fetch(url, {
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

// Push a structured event to the web service's central log. Best-effort:
// failures are swallowed so logging never breaks the call. Mirrors locally
// to stdout in case the network call fails.
const remoteLog = async (
  source: string,
  event: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
  metadata: Record<string, unknown> = {},
): Promise<void> => {
  console.log(`[${source}:${event}]`, message, metadata);
  const appUrl = process.env['APP_URL'];
  const secret = process.env['INTERNAL_SECRET'];
  if (!appUrl || !secret) return;
  try {
    await fetch(`${appUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({ source, event, message, level, metadata }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* ignore */
  }
};

// POST the recorded transcript + numbers to the web service so it can
// summarize and dispatch WhatsApp messages. Best-effort: never throws so a
// post-call failure can't crash the agent.
const postCallEnd = async (
  transcript: TranscriptEntry[],
  fromNumber: string,
  toNumber: string,
) => {
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
      body: JSON.stringify({ fromNumber, toNumber, transcript }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    console.log(
      `[recap] /api/calls/end → ${res.status} ${body.slice(0, 200)}`,
    );
  } catch (e) {
    console.error(`[recap] failed: ${(e as Error).message}`);
  }
};

// LiveKit SIP exposes:
//   sip.phoneNumber       = caller's number (From)
//   sip.trunkPhoneNumber  = number that was dialed (To, the tenant's line)
// The participant identity is also `sip_<from>` as a fallback.
const sipFromOf = (p: { attributes: Record<string, string>; identity: string }): string => {
  const attr = p.attributes['sip.phoneNumber'];
  if (attr) return attr;
  return p.identity.startsWith('sip_') ? p.identity.slice(4) : '';
};
const sipToOf = (p: { attributes: Record<string, string> }): string =>
  p.attributes['sip.trunkPhoneNumber'] ?? '';

// Poll the SIP participant's attributes for the dialed number. LiveKit
// sets `sip.trunkPhoneNumber` once the participant is published, which can
// arrive a beat after `connect()` returns. Time-bounded so we never block
// the call for too long — fall back to default tenant if unset.
const waitForCalledNumber = async (
  ctx: JobContext<ProcessUserData>,
  timeoutMs: number,
): Promise<string> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const [, p] of ctx.room.remoteParticipants) {
      const t = sipToOf(p);
      if (t) return t;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return '';
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

    // Resolve the called number BEFORE fetching config so we can route to
    // the right tenant. SIP participant attributes arrive shortly after the
    // room connects — wait briefly for them.
    const calledNumber = await waitForCalledNumber(ctx, 3_000);
    await remoteLog(
      'agent',
      'call_started',
      `Appel reçu sur ${calledNumber || '(numéro inconnu)'}`,
      'info',
      { calledNumber, roomName: ctx.room.name },
    );

    const cfg = await fetchConfig(calledNumber);
    await remoteLog(
      'agent',
      'config_loaded',
      `Config chargée : ${cfg.model} / ${cfg.voice} / t°${cfg.temperature}`,
      'info',
      { model: cfg.model, voice: cfg.voice, temperature: cfg.temperature },
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
    let toNumber = calledNumber;
    let recapSent = false;

    const captureNumbers = (p: {
      attributes: Record<string, string>;
      identity: string;
    }) => {
      const f = sipFromOf(p);
      const t = sipToOf(p);
      if (f) fromNumber = f;
      if (t) toNumber = t;
    };
    for (const [, p] of ctx.room.remoteParticipants) captureNumbers(p);
    ctx.room.on(RoomEvent.ParticipantConnected, (p) => captureNumbers(p));
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
      captureNumbers(p);
    });

    // Extract plain text from a ChatMessage content[] entry. Realtime models
    // emit objects like { type: 'audio', transcript: '...' } or
    // { type: 'text', text: '...' } rather than raw strings, so we probe the
    // common fields before giving up.
    const extractText = (content: unknown): string => {
      if (!content) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(extractText).filter(Boolean).join(' ').trim();
      }
      if (typeof content === 'object') {
        const obj = content as Record<string, unknown>;
        for (const key of ['transcript', 'text', 'content']) {
          const v = obj[key];
          if (typeof v === 'string' && v.trim()) return v;
          if (Array.isArray(v)) {
            const joined = extractText(v);
            if (joined) return joined;
          }
        }
      }
      return '';
    };

    // Belt & braces: realtime models commit final user turns via
    // ConversationItemAdded too, but UserInputTranscribed is the canonical
    // STT-style event. Keep both, dedupe by skipping empty text.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const text = (ev.transcript ?? '').trim();
      if (text) transcript.push({ role: 'user', text });
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item as {
        type?: string;
        role?: string;
        content?: unknown;
      };
      if (item?.type !== 'message') return;
      if (item.role !== 'assistant' && item.role !== 'user') return;
      const text = extractText(item.content);
      if (!text) return;
      // Dedupe vs the parallel UserInputTranscribed stream.
      const last = transcript[transcript.length - 1];
      if (last && last.role === item.role && last.text === text) return;
      transcript.push({ role: item.role as 'user' | 'assistant', text });
    });

    // ── End-of-call recap ───────────────────────────────────────────────
    const triggerRecap = async () => {
      if (recapSent) return;
      recapSent = true;
      await postCallEnd(transcript, fromNumber, toNumber);
    };

    // ── Auto-hangup ─────────────────────────────────────────────────────
    // Two triggers:
    //   1. The LLM calls the `end_call` tool when the conversation is done.
    //   2. No activity (user speech / agent speech / tool execution) for
    //      SILENCE_HANGUP_MS — the call is dead, hang up.
    const sessionStartedAt = Date.now();
    let lastActivity = sessionStartedAt;
    let closing = false;
    const resetActivity = () => {
      lastActivity = Date.now();
    };
    const closeSession = async (reason: string) => {
      if (closing) return;
      closing = true;
      await remoteLog(
        'agent',
        'auto_hangup',
        `Hangup auto: ${reason}`,
        'info',
        { reason, transcriptEntries: transcript.length },
      );
      try {
        await session.close();
      } catch (e) {
        console.warn('[hangup] session.close threw:', (e as Error).message);
      }
    };

    // Reset on any activity that means "the call is alive".
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, resetActivity);
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if ((ev as { newState?: string }).newState === 'speaking') {
        resetActivity();
      }
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      const next = (ev as { newState?: string }).newState;
      // 'listening' is the idle state where we WANT to count silence — only
      // reset on 'speaking' / 'thinking' / 'initializing' which represent
      // active processing.
      if (next && next !== 'listening') resetActivity();
    });
    // Tool execution counts as activity — calendar lookups can take seconds.
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, resetActivity);

    const silenceWatcher = setInterval(() => {
      if (closing) return;
      // Grace period at the start: don't hang up just because the customer
      // takes a beat to respond to the greeting.
      if (Date.now() - sessionStartedAt < SILENCE_GRACE_START_MS) return;
      if (Date.now() - lastActivity > SILENCE_HANGUP_MS) {
        clearInterval(silenceWatcher);
        void closeSession(`silence_${SILENCE_HANGUP_MS}ms`);
      }
    }, 2_000);

    // ── end_call tool — exposed to the LLM ──────────────────────────────
    const endCallTool = llm.tool({
      description:
        "Termine l'appel proprement. À appeler UNIQUEMENT après avoir dit au revoir, quand la conversation est conclue (RDV pris/annulé/déplacé, info donnée et plus rien à demander, ou client a explicitement raccroché verbalement). Ne PAS appeler en plein milieu d'un échange.",
      parameters: z.object({
        reason: z
          .string()
          .nullish()
          .describe(
            "Raison courte du raccroché : 'rdv_pris', 'rdv_annulé', 'info_donnée', 'client_raccroche', etc.",
          ),
      }),
      execute: async ({ reason }) => {
        const r = (reason ?? 'llm_end').trim() || 'llm_end';
        // Delay a beat so the agent's farewell speech finishes playing
        // before we tear down the audio path.
        setTimeout(() => void closeSession(`tool:${r}`), END_CALL_GRACE_MS);
        return 'Au revoir.';
      },
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
      tools: { ...calendarTools, end_call: endCallTool },
    });

    // Wait until the session actually emits Close (caller hung up OR we
    // closed it ourselves via end_call/silence). session.start() resolves
    // on setup, NOT on call end — register the one-shot Close listener now.
    const sessionClosed = new Promise<void>((resolve) => {
      session.once(voice.AgentSessionEventTypes.Close, () => resolve());
    });

    try {
      await session.start({ agent, room: ctx.room });
      await sessionClosed;
    } finally {
      clearInterval(silenceWatcher);
      await remoteLog(
        'agent',
        'call_ended',
        `Appel terminé · ${transcript.length} entries · from=${fromNumber || '?'} to=${toNumber || '?'}`,
        'info',
        {
          transcriptEntries: transcript.length,
          fromNumber,
          toNumber,
        },
      );
      await triggerRecap();
    }
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
  }),
);
