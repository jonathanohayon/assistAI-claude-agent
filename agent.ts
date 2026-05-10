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
import * as aic from '@livekit/plugins-ai-coustics';
import { RoomEvent } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import { z } from 'zod';

import {
  AGENT_NAME,
  GREETING_INSTRUCTIONS as FALLBACK_GREETING,
  INSTRUCTIONS as FALLBACK_INSTRUCTIONS,
  REALTIME_CONFIG,
} from './config.js';
import { makeCalendarTools } from './tools/calendar.js';

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
      if (!text) return;
      transcript.push({ role: 'user', text });
      // Cheap charset-based language sniff: log the dominant script so we
      // can verify after the fact that Hebrew turns are transcribed as
      // Hebrew, not as French gibberish (whisper-1 used to do that).
      const hebrewChars = (text.match(/[֐-׿]/g) ?? []).length;
      const latinChars = (text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
      const langSniff =
        hebrewChars > latinChars ? 'he' : latinChars > 0 ? 'lat' : '?';
      console.log(
        `[lang_sniff] user turn: ${langSniff} | "${text.slice(0, 60)}"`,
      );
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
      // session.close() only stops the agent's audio pipeline. To actually
      // hang up the SIP call (= make Twilio drop the line + stop billing),
      // we must delete the LiveKit room — this disconnects ALL participants
      // including the SIP one. Without this, the caller hears silence after
      // the agent's last words but the line stays open.
      try {
        const lkUrl = process.env['LIVEKIT_URL'];
        const lkKey = process.env['LIVEKIT_API_KEY'];
        const lkSecret = process.env['LIVEKIT_API_SECRET'];
        if (lkUrl && lkKey && lkSecret) {
          const httpUrl = lkUrl.replace(/^wss?:\/\//, (m) =>
            m === 'wss://' ? 'https://' : 'http://',
          );
          const svc = new RoomServiceClient(httpUrl, lkKey, lkSecret);
          await svc.deleteRoom(ctx.room.name ?? '');
        } else {
          console.warn(
            '[hangup] LIVEKIT_URL/KEY/SECRET missing — skipping deleteRoom (SIP call may stay open)',
          );
        }
      } catch (e) {
        console.warn('[hangup] deleteRoom threw:', (e as Error).message);
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

    // Greeting: prefer the tenant's stored greetingInstructions (editable
    // from /dashboard). Fall back to a generic prompt that asks the LLM to
    // derive the greeting from the persona system prompt — keeps things
    // working for tenants who haven't filled in the field.
    const customGreeting = cfg.greetingInstructions?.trim();
    const greetInstructions =
      customGreeting && customGreeting.length > 0
        ? customGreeting
        : `Salue chaleureusement la cliente en te présentant : utilise ton prénom et le nom du centre tels que définis dans tes instructions système. Demande poliment comment tu peux l'aider. Si la cliente répond en hébreu, bascule en hébreu pour la suite de l'échange.`;

    class TenantAgent extends voice.Agent {
      override async onEnter(): Promise<void> {
        await this.session.generateReply({
          instructions: greetInstructions,
        });
      }
    }

    // Hard-coded suffix appended to every tenant's instructions. The realtime
    // model often forgets to invoke end_call after a polite goodbye; this
    // section is short, prescriptive, and always present so the LLM knows
    // exactly when and how to hang up.
    const HANGUP_DIRECTIVE = `

──────────────────────────────────────────
**RÈGLE DE FIN D'APPEL — OBLIGATOIRE**
Quand la conversation est CLAIREMENT terminée — la cliente a dit "au revoir / merci / à bientôt / shalom", OU le RDV est pris et elle n'a plus rien à ajouter, OU elle a raccroché verbalement — tu DOIS :

1. Dire ta phrase de clôture chaleureuse ("Au revoir Sarah, à très vite !")
2. **Immédiatement** après, appeler le tool \`end_call\` avec un argument \`reason\` court (\`rdv_pris\`, \`rdv_annulé\`, \`info_donnée\`, \`client_raccroche\`, etc.)

Ne JAMAIS attendre que la cliente raccroche elle-même — c'est ton rôle de clôturer la ligne. Si tu oublies d'appeler end_call, la cliente reste connectée pour rien et continue de payer la communication.

Ne PAS appeler end_call en plein milieu d'un échange ou sur la moindre pause.
──────────────────────────────────────────`;

    // Bind the calendar/sheets tools to THIS tenant's dialed number so they
    // hit the right Google Calendar/Sheet on the web service. Without this,
    // the routes fall back to the admin's credentials (= cross-tenant leak).
    const internalSecret = process.env['INTERNAL_SECRET'] ?? '';
    if (!internalSecret) {
      console.warn(
        '[tools] INTERNAL_SECRET not set — calendar/sheet calls will fall back to the demo (admin) account on the web service.',
      );
    }
    if (!toNumber) {
      console.warn(
        '[tools] dialed number unresolved — calendar/sheet calls will fall back to the demo (admin) account on the web service.',
      );
    }
    const calendarTools = makeCalendarTools({
      appUrl: process.env['APP_URL'] ?? 'http://localhost:3002',
      dialedPhone: toNumber,
      internalSecret,
      // Live getter — fromNumber may arrive AFTER tools are built (SIP attrs
      // race). Convert +972 → 0 here too so the WhatsApp the owner reads
      // shows the local format directly.
      getCallerPhone: () =>
        fromNumber.startsWith('+972') ? '0' + fromNumber.slice(4) : fromNumber,
    });

    // Current date/time in Jerusalem — injected so the LLM can resolve
    // relative dates ("demain", "lundi prochain") correctly. Without this,
    // the realtime model has zero clock awareness and either hallucinates
    // or asks. Date is in French long form for natural reading.
    const nowJerusalem = (() => {
      const d = new Date();
      const dateFr = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Asia/Jerusalem',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(d);
      const time = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Asia/Jerusalem',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(d);
      const isoDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d); // YYYY-MM-DD
      return { dateFr, time, isoDate };
    })();

    const dateContextBlock = `

──────────────────────────────────────────
**CONTEXTE TEMPOREL (Asia/Jerusalem)**
- Aujourd'hui : ${nowJerusalem.dateFr} (\`${nowJerusalem.isoDate}\`)
- Heure locale : ${nowJerusalem.time}
- Fuseau de référence : Asia/Jerusalem (toutes les dates et heures que tu manipules sont dans ce fuseau)

Quand la cliente dit "demain", "lundi prochain", "dans 2 semaines", etc. → calcule la date YYYY-MM-DD à partir d'aujourd'hui ci-dessus AVANT d'appeler un tool. Ne demande JAMAIS la date complète à la cliente, ce serait étrange ("c'est quel jour aujourd'hui ?").
──────────────────────────────────────────`;

    // Hard-coded directive on how to PRONOUNCE times to the customer.
    // The realtime TTS reads "09:00" literally as "zéro neuf zéro zéro" —
    // unnatural. We instruct it to convert to spoken French/Hebrew before
    // speaking, while keeping HH:MM in the tool args.
    const SPOKEN_TIME_DIRECTIVE = `

──────────────────────────────────────────
**PRONONCIATION DES HEURES — IMPORTANT**
Quand tu lis une heure à VOIX HAUTE à la cliente, formate-la naturellement. NE LIS JAMAIS le format \`HH:MM\` littéral, ça donne "zéro neuf zéro zéro" — c'est moche.

En français :
- \`09:00\` → "neuf heures" (ou "neuf heures du matin" si ambigu)
- \`09:30\` → "neuf heures et demie" ou "neuf heures trente"
- \`10:15\` → "dix heures et quart"
- \`11:45\` → "midi moins le quart"
- \`12:00\` → "midi"
- \`12:30\` → "midi et demi"
- \`13:00\` → "treize heures" ou "une heure de l'après-midi"
- \`18:00\` → "six heures du soir" ou "dix-huit heures"

En hébreu :
- \`09:00\` → "תשע בבוקר"
- \`09:30\` → "תשע וחצי"
- \`12:00\` → "שתים-עשרה בצהריים"
- \`18:00\` → "שש בערב"

Quand tu PASSES une heure à un tool (\`book_appointment\`, etc.), garde le format \`HH:MM\` dans les arguments — c'est uniquement la prononciation orale qui change.
──────────────────────────────────────────`;

    // Convert E.164 to Israeli local format for both speaking AND tool args.
    // +972585001007 → 0585001007. Customers dictate local format, store in
    // local format, agent reads local format. Other country codes stay as-is
    // (the SPOKEN_PHONE_DIRECTIVE handles digit-by-digit pronunciation).
    const localFromNumber = fromNumber.startsWith('+972')
      ? '0' + fromNumber.slice(4)
      : fromNumber;

    // Hard directive on how to PRONOUNCE phone numbers. Realtime models
    // default to compound numbers ("cinq cent quatre-vingt-cinq mille…")
    // which is unintelligible. Force digit-by-digit.
    const SPOKEN_PHONE_DIRECTIVE = `

──────────────────────────────────────────
**PRONONCIATION DES NUMÉROS DE TÉLÉPHONE — IMPORTANT**
Quand tu lis un numéro de téléphone à VOIX HAUTE :
1. JAMAIS l'indicatif international (\`+972\`, \`+33\`, etc.) — utilise toujours le format local israélien (commence par \`0\`).
2. Lis CHIFFRE PAR CHIFFRE, jamais comme un grand nombre. \`0585001007\` se lit "zéro, cinq, huit, cinq, zéro, zéro, un, zéro, zéro, sept" — PAS "cinq cent quatre-vingt-cinq mille…".
3. Groupe par paires pour la fluidité : \`05 85 00 10 07\` → "zéro cinq, huit cinq, zéro zéro, un zéro, zéro sept" avec une micro-pause entre chaque paire.

En hébreu, même logique : chiffre par chiffre, groupé par paires.
- \`0585001007\` → "אפס חמש, שמונה חמש, אפס אפס, אחת אפס, אפס שבע"

En anglais : "zero five, eight five, zero zero, one zero, zero seven".

Cette règle s'applique à TOUS les numéros que tu énonces — celui qui appelle, celui qu'une cliente te dicte pour confirmation, etc.
──────────────────────────────────────────`;

    // Inject the caller's number (when known) so the LLM proposes it for
    // confirmation instead of asking blind. We don't blindly trust it —
    // sometimes a customer calls from a relative's phone, so the LLM must
    // confirm before using it. Withheld/private numbers leave fromNumber
    // empty → no hint → LLM asks like before.
    const callerHint = localFromNumber
      ? `

──────────────────────────────────────────
**NUMÉRO DU CLIENT (détecté via l'appel)**
Le numéro qui appelle est : \`${localFromNumber}\` (format local, à utiliser tel quel pour les tools).

Avant d'utiliser ce numéro pour un tool (\`book_appointment\`, \`save_contact\`, etc.), CONFIRME-le avec la cliente — formule courte du genre :
  « Je note le rendez-vous au numéro qui appelle, le \`${localFromNumber}\`, c'est bien le bon ? »
ou en hébreu : « אני רושמת את התור על המספר שממנו את מתקשרת, \`${localFromNumber}\`, נכון? »

Rappel : prononce chiffre par chiffre par paires (voir directive ci-dessus), pas comme un grand nombre.

- Si elle confirme → utilise \`${localFromNumber}\` dans le champ \`phone\`.
- Si elle te donne un AUTRE numéro (elle appelle depuis le tel de sa mère, du bureau, etc.) → utilise celui qu'elle te dicte.

Tu n'as PAS besoin de demander son numéro de zéro — propose toujours \`${localFromNumber}\` pour confirmation d'abord, ça gagne du temps.
──────────────────────────────────────────`
      : '';

    const agent = new TenantAgent({
      instructions:
        cfg.instructions +
        dateContextBlock +
        SPOKEN_TIME_DIRECTIVE +
        SPOKEN_PHONE_DIRECTIVE +
        HANGUP_DIRECTIVE +
        callerHint,
      tools: { ...calendarTools, end_call: endCallTool },
    });

    // Wait until the session actually emits Close (caller hung up OR we
    // closed it ourselves via end_call/silence). session.start() resolves
    // on setup, NOT on call end — register the one-shot Close listener now.
    const sessionClosed = new Promise<void>((resolve) => {
      session.once(voice.AgentSessionEventTypes.Close, () => resolve());
    });

    try {
      await session.start({
        agent,
        room: ctx.room,
        // ai-coustics noise cancellation. Cleans up background noise (street,
        // ventilation, music, kids) coming from the caller before it reaches
        // the LLM. Drastically improves recognition on noisy phone calls.
        // The default model (rookS) is tuned for low-latency telephony; pass
        // `model: 'quailL'` for higher quality at the cost of CPU.
        inputOptions: {
          noiseCancellation: aic.audioEnhancement(),
        },
      });
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
