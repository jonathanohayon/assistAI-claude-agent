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
// 2026-05-15 : ai-coustics **Quail Voice Focus 2.1 L** comme NR unique.
// Modèle 20 MB, window 15ms, latence 30ms, optimisé CPU temps réel.
// Bench interne : -81% WER vs API Realtime standard sur 7 STT
// (AssemblyAI/Deepgram/Soniox/Mistral/Cartesia/Gladia/Speechmatics).
// ⚠️ ai-coustics avait été retiré le 10/05 pour saturation CPU sur
// l'ancien modèle. QVF 2.1 L est ≈4× plus léger — à monitorer post-deploy
// via logs "inference is slower than realtime". Si re-sature, fallback :
// model "quailVfS" (5.3 MB, même fenêtre 15ms).
import { audioEnhancement } from '@livekit/plugins-ai-coustics';
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
// Hard-cap delay between an LLM-triggered end_call and the actual close.
// We normally wait for the agent's "speaking → idle/listening" transition
// (= goodbye audio finished). This is a safety net if that event never
// fires (tool call without speech, stuck state, etc.).
const END_CALL_HARD_CAP_MS = 8_000;
// Min hold after the goodbye finishes streaming, to flush the last frames
// of audio over the SIP RTP buffer to the caller.
const END_CALL_TRAILING_MS = 600;
// Grace period at the start of the call before the silence watchdog kicks
// in. The customer might pause briefly after the greeting; we don't want to
// pre-empt them.
const SILENCE_GRACE_START_MS = 10_000;

// Le worker n'a plus de state de prewarm partagé (Silero retiré). On
// garde le générique pour stabilité d'API au cas où on en ajouterait.
type ProcessUserData = Record<string, never>;

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Variable d'environnement manquante : ${key}`);
  return value;
};

// Map plan × feature renvoyée par /api/agent/config (cf. lib/plan-features
// côté web). Clés inconnues ignorées — on lit défensivement avec ?? false.
interface AgentFeatures {
  calendar?: boolean;
  crm?: boolean;
  whatsapp_confirm?: boolean;
  whatsapp_recap?: boolean;
}

interface FetchedConfig {
  instructions: string;
  greetingInstructions: string;
  model: string;
  voice: string;
  temperature: number;
  speed: number;
  maxResponseTokens: number;
  features: AgentFeatures;
  /** Slider 1-10 piloté depuis /dashboard. Mappé vers enhancementLevel
   *  0.1-1.0 du QVF 2.1 L à la création de la session. */
  noiseReductionLevel: number;
  // Template injecté en chatCtx au début de chaque appel. Contient des
  // placeholders runtime : {date_fr}, {iso_date}, {time}, {caller_hint_block}.
  // Édité depuis /admin (web). Vide → fallback hardcoded ci-dessous.
  perCallContextTemplate?: string;
}

interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Source de la session :
 *  - "sip"   : appel Twilio entrant, on lit `sip.trunkPhoneNumber`
 *  - "web"   : LiveTest depuis le navigateur (Phase 2), userId via metadata
 *  - "unknown" : ni l'un ni l'autre — fallback default tenant
 */
type SessionOrigin =
  | { kind: 'sip'; calledNumber: string }
  | { kind: 'web'; userId: string }
  | { kind: 'unknown' };

const fetchConfig = async (origin: SessionOrigin): Promise<FetchedConfig> => {
  const appUrl = process.env['APP_URL'];
  if (!appUrl) {
    console.warn('[config] APP_URL not set, using compiled defaults');
    return defaultConfig();
  }
  try {
    const url =
      origin.kind === 'sip'
        ? `${appUrl}/api/agent/config?phone=${encodeURIComponent(origin.calledNumber)}`
        : origin.kind === 'web'
          ? `${appUrl}/api/agent/config?userId=${encodeURIComponent(origin.userId)}`
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
      // Slider 1-10 ; si /api/agent/config n'a pas encore le champ (DB
      // pas migrée ou ancien deploy), fallback sur 8 = enhancementLevel
      // 0.8 (équilibré).
      noiseReductionLevel:
        typeof data.noiseReductionLevel === 'number'
          ? Math.min(10, Math.max(1, Math.round(data.noiseReductionLevel)))
          : 8,
      // Si le web n'a pas (encore) déployé le champ features, on
      // ouvre tout par défaut (mode legacy = plan premium implicite).
      features: data.features ?? DEFAULT_FEATURES,
      // Vide si le web n'a pas (encore) ce champ → fallback ci-dessous
      // dans la composition du PER_CALL_CONTEXT. exactOptionalPropertyTypes
      // refuse 'undefined' explicite ; on omet la clé si vide.
      ...(data.perCallContextTemplate !== undefined
        ? { perCallContextTemplate: data.perCallContextTemplate }
        : {}),
    };
  } catch (e) {
    console.warn(`[config] fetch failed (${(e as Error).message}), using defaults`);
    return defaultConfig();
  }
};

// Permissif par défaut — si le fetch échoue ou si l'admin n'a pas encore
// configuré la matrice, le tenant garde toutes les capacités au lieu de
// se retrouver muet (failure-open). C'est volontaire : un trial qui perd
// silencieusement ses tools serait dur à diagnostiquer.
const DEFAULT_FEATURES: AgentFeatures = {
  calendar: true,
  crm: true,
  whatsapp_confirm: true,
  whatsapp_recap: true,
};

const defaultConfig = (): FetchedConfig => ({
  instructions: FALLBACK_INSTRUCTIONS,
  greetingInstructions: FALLBACK_GREETING,
  model: REALTIME_CONFIG.model,
  voice: REALTIME_CONFIG.voice,
  temperature: REALTIME_CONFIG.temperature,
  speed: REALTIME_CONFIG.speed,
  maxResponseTokens: 220,
  noiseReductionLevel: 8,
  features: DEFAULT_FEATURES,
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

/**
 * Lit `participant.metadata` (JSON) pour détecter un participant web
 * (Phase 2 LiveTest routing). Format émis par /api/livekit/web-token :
 * `{ "source": "web", "userId": "<uuid>" }`. Retourne userId si trouvé,
 * sinon null. Silent sur metadata invalide pour ne pas crasher l'agent.
 */
const webUserIdOf = (p: { metadata?: string }): string | null => {
  if (!p.metadata) return null;
  try {
    const parsed = JSON.parse(p.metadata) as { source?: string; userId?: string };
    if (parsed.source === 'web' && typeof parsed.userId === 'string') {
      return parsed.userId;
    }
  } catch {
    // metadata absente ou pas JSON → pas un participant web
  }
  return null;
};

// Détecte l'origine de la session (SIP Twilio ou Web LiveTest) en
// pollant les remoteParticipants jusqu'à ce que les attributes / metadata
// arrivent (le SDK LiveKit les publie un beat après `connect()`).
// Time-bounded pour ne jamais bloquer un appel — fallback "unknown".
const detectOrigin = async (
  ctx: JobContext<ProcessUserData>,
  timeoutMs: number,
): Promise<SessionOrigin> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const [, p] of ctx.room.remoteParticipants) {
      // 1. SIP attributes (Twilio)
      const calledNumber = sipToOf(p);
      if (calledNumber) return { kind: 'sip', calledNumber };
      // 2. Web metadata (Phase 2 LiveTest)
      const userId = webUserIdOf(p);
      if (userId) return { kind: 'web', userId };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { kind: 'unknown' };
};

export default defineAgent<ProcessUserData>({
  // Silero VAD désactivé : en Realtime mode, OpenAI gère server_vad pour
  // la détection de tour. Le Silero local servait uniquement à
  // l'interrupt detection. Sur le worker Railway, son inférence saturait
  // le CPU (logs "inference is slower than realtime delay=2800ms")
  // créant un backlog audio qui décalait TOUT le pipeline :
  //   - greeting 33s (au lieu de ~2s)
  //   - détection user speech/silence en retard de 3s
  //   - agent réagit aux mauvais moments
  // Les events OpenAI input_audio_buffer.speech_started / stopped
  // suffisent pour gérer l'interrupt côté agent SDK.
  prewarm: async () => {
    // no-op (anciennement chargeait Silero VAD)
  },

  entry: async (ctx: JobContext<ProcessUserData>) => {
    const apiKey = process.env['REALTIME_API_KEY'] ?? requireEnv('OPENAI_API_KEY');

    // Phase timings — Date.now() pris à chaque transition pour identifier
    // exactement où le temps passe entre l'entry() et le moment où le
    // greeting commence à sortir. Inclus dans call_metrics à la fin.
    const phaseT0 = Date.now();
    let tConnectDone = 0;
    let tSipResolved = 0;
    let tConfigFetched = 0;
    let tSessionStarted = 0;

    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    tConnectDone = Date.now();

    // Résout l'origine (SIP Twilio ou Web LiveTest) AVANT le fetch config.
    // Les attributes/metadata arrivent un beat après `connect()` — on
    // wait briefly. Réduit à 1.5s : sur les tests prod les attrs SIP
    // arrivent en <500ms. Au-delà de 1.5s on tombe sur 'unknown' →
    // fetchConfig fallback default-tenant.
    const origin = await detectOrigin(ctx, 1_500);
    tSipResolved = Date.now();
    const originLabel =
      origin.kind === 'sip'
        ? `SIP ${origin.calledNumber}`
        : origin.kind === 'web'
          ? `Web user ${origin.userId}`
          : '(origine inconnue)';
    await remoteLog(
      'agent',
      'call_started',
      `Session démarrée — ${originLabel}`,
      'info',
      { origin, roomName: ctx.room.name },
    );

    const cfg = await fetchConfig(origin);
    tConfigFetched = Date.now();
    await remoteLog(
      'agent',
      'config_loaded',
      `Config chargée : ${cfg.model} / ${cfg.voice} / t°${cfg.temperature}`,
      'info',
      { model: cfg.model, voice: cfg.voice, temperature: cfg.temperature },
    );

    // ── OpenAI Realtime server-event timings ─────────────────────────────
    // En mode Realtime, le SDK LiveKit n'expose pas transcriptionDelay /
    // endOfUtteranceDelay (eou_metrics laissé à undefined — OpenAI gère STT
    // et turn detection en interne). On les calcule nous-mêmes depuis les
    // events serveur OpenAI :
    //   - input_audio_buffer.speech_stopped  → user finished speaking
    //   - conversation.item.input_audio_transcription.completed  → STT done
    //   - response.created  → agent starts generating
    //   - response.output_audio.delta (1er) → first audio token
    //
    // Du coup :
    //   transcriptionDelayMs = transcription.completed - speech_stopped
    //   endOfUtteranceDelayMs = response.created - speech_stopped
    //   firstAudioDelayMs = response.audio.delta[0] - response.created
    //
    // Important : declared BEFORE class LoggingRealtimeModel pour que le
    // closure capture les bonnes refs au moment du handler.
    const serverTranscriptionDelayMs: number[] = [];
    const serverEouDelayMs: number[] = [];
    const serverFirstAudioDelayMs: number[] = [];
    // 2 refs séparées : OpenAI envoie transcription.completed APRÈS
    // response.created (Whisper async). Un seul ref nullé à response.created
    // raterait transcription.completed. Un seul ref non-nullé risquerait la
    // race au prochain speech_stopped (turn N+1 overwrite avant turn N
    // transcription.completed arrive). Séparer = chaque event consomme sa
    // ref et la nulle, et speech_stopped les re-pose toutes les deux.
    let speechStoppedForEouMs: number | null = null;
    let speechStoppedForTransMs: number | null = null;
    let lastResponseCreatedAtMs: number | null = null;
    let firstAudioCapturedForResponse = false;

    // Generic OpenAI server-event listener : capture les timings clés pour
    // l'instrumentation latence, et log les errors serveur.
    class LoggingRealtimeModel extends openai.realtime.RealtimeModel {
      override session(): openai.realtime.RealtimeSession {
        const sess = super.session();
        sess.on('openai_server_event_received', (event: unknown) => {
          const e = event as {
            type?: string;
            error?: { message?: string; param?: string };
          };
          const now = Date.now();
          switch (e?.type) {
            case 'input_audio_buffer.speech_stopped':
              speechStoppedForEouMs = now;
              speechStoppedForTransMs = now;
              break;
            case 'conversation.item.input_audio_transcription.completed':
              if (speechStoppedForTransMs !== null) {
                const delta = now - speechStoppedForTransMs;
                if (delta >= 0) serverTranscriptionDelayMs.push(delta);
                speechStoppedForTransMs = null;
              }
              break;
            case 'response.created':
              if (speechStoppedForEouMs !== null) {
                const delta = now - speechStoppedForEouMs;
                if (delta >= 0) serverEouDelayMs.push(delta);
                speechStoppedForEouMs = null;
              }
              lastResponseCreatedAtMs = now;
              firstAudioCapturedForResponse = false;
              break;
            case 'response.output_audio.delta':
              // OpenAI envoie plusieurs deltas par réponse, on garde
              // uniquement le 1er pour mesurer la latence "time to first
              // audio chunk côté serveur".
              if (!firstAudioCapturedForResponse && lastResponseCreatedAtMs !== null) {
                const delta = now - lastResponseCreatedAtMs;
                if (delta >= 0) serverFirstAudioDelayMs.push(delta);
                firstAudioCapturedForResponse = true;
              }
              break;
            case 'error': {
              const errMsg = e.error?.message ?? 'erreur inconnue';
              console.warn('[realtime_server_error]', errMsg);
              void remoteLog(
                'agent',
                'realtime_server_error',
                `OpenAI Realtime error : ${errMsg.slice(0, 300)}`,
                'error',
                { rawEvent: event },
              );
              break;
            }
          }
        });
        return sess;
      }
    }

    const session = new voice.AgentSession({
      // Pas de VAD local (Silero retiré car saturait le CPU du worker).
      // OpenAI server_vad gère la détection de tour côté serveur.
      llm: new LoggingRealtimeModel({
        apiKey,
        baseURL: REALTIME_CONFIG.apiBase,
        model: cfg.model,
        modalities: [...REALTIME_CONFIG.modalities],
        voice: cfg.voice,
        // temperature : deprecated dans l'API GA (renvoyait unknown_parameter
        // sur certaines combos). On laisse au défaut du modèle.
        speed: cfg.speed,
        // maxResponseOutputTokens : SDK default = 'inf'. On a tenté un cap
        // 220 (tunable depuis admin) le 12/05/26 — ça coupait le greeting
        // mid-phrase. La longueur de réponse est désormais gouvernée
        // uniquement par le prompt (cf. INSTRUCTIONS "max 1-2 phrases").
        inputAudioTranscription: {
          model: REALTIME_CONFIG.transcriptionModel,
        },
        // inputAudioNoiseReduction RETIRÉ — ai-coustics Quail Voice
        // Focus 2.1 L (cf. inputOptions.noiseCancellation plus bas)
        // gère toute la noise reduction côté worker AVANT que l'audio
        // atteigne OpenAI. Double pass redondant + ajoutait ~5-10ms
        // de latence inutile + altérait parfois la queue de phonèmes
        // déjà bien isolée par QVF.
        // Optims latence aggressives (cible : TTFA p50 ~550ms, p95 <1100ms) :
        // - threshold 0.75 : VAD très confiant, ignore plus de bruits courts
        // - silence_duration_ms 350 : l'agent répond ~130ms plus vite après
        //   la fin de phrase user (vs 480 avant). Risque : si la cliente
        //   prend une grosse respiration mid-phrase, l'agent peut couper.
        //   Compensé par threshold haut qui filtre les hésitations courtes.
        // - prefix_padding_ms 150 : moins de buffer avant détection (vs 250).
        //   Économise ~100ms sur le démarrage de la transcription.
        // - create_response: true : l'API génère la réponse directement à
        //   la fin du tour user, sans attendre un trigger explicite.
        turnDetection: {
          type: 'server_vad',
          threshold: 0.75,
          prefix_padding_ms: 150,
          silence_duration_ms: 350,
          create_response: true,
        },
      }),
    });

    // ── Transcript capture ──────────────────────────────────────────────
    const transcript: TranscriptEntry[] = [];
    let fromNumber = '';
    let toNumber = origin.kind === 'sip' ? origin.calledNumber : '';
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

    // Pour les sessions web (LiveTest navigateur), publish chaque turn sur
    // le data channel de la room afin que la UI navigateur puisse afficher
    // la transcription en temps réel. Pas applicable côté SIP (Twilio
    // n'écoute pas le data channel). Encodage JSON utf-8 simple.
    const publishWebTranscript = (entry: TranscriptEntry) => {
      if (origin.kind !== 'web') return;
      try {
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: 'transcript', ...entry }),
        );
        // reliable = true : l'utilisateur préfère un texte qui arrive un
        // peu plus tard plutôt que des bouts perdus.
        ctx.room.localParticipant?.publishData(payload, { reliable: true });
      } catch (err) {
        console.warn('[web_transcript] publish failed:', (err as Error).message);
      }
    };

    // Belt & braces: realtime models commit final user turns via
    // ConversationItemAdded too, but UserInputTranscribed is the canonical
    // STT-style event. Keep both, dedupe by skipping empty text.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (!ev.isFinal) return;
      const text = (ev.transcript ?? '').trim();
      if (!text) return;
      const entry: TranscriptEntry = { role: 'user', text };
      transcript.push(entry);
      publishWebTranscript(entry);
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
      const entry: TranscriptEntry = {
        role: item.role as 'user' | 'assistant',
        text,
      };
      transcript.push(entry);
      publishWebTranscript(entry);
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

    // ── Latency instrumentation ─────────────────────────────────────────
    // Sources :
    //   - Native LiveKit `MetricsCollected` events (canonical TTFA, EOU,
    //     transcription delays, token counts incl. cache hit ratio).
    //   - Manual fallback (greetingMs / wallclockTurnLatenciesMs) en cas
    //     où les métriques natives ne fire pas (différence de provider,
    //     cancelled responses, etc.) — sert aussi de cross-check.
    let sessionStartedAtMs: number | null = null;
    let greetingMs: number | null = null;
    let lastUserDoneAtMs: number | null = null;
    const wallclockTurnLatenciesMs: number[] = [];

    // Native realtime model metrics — TTFT (time-to-first-audio-token), the
    // primary user-perceived latency for Realtime API. We collect every
    // sample so we can compute mean, p50, p95 at call end.
    const ttftMsList: number[] = [];
    const responseDurationMs: number[] = [];
    // Cache hit accounting (input tokens cached vs total) — confirms the
    // prompt-cache optimization is working tenant-by-tenant.
    let inputTokensTotal = 0;
    let cachedInputTokens = 0;
    // EOU (end-of-utterance) and transcription latency — useful to split
    // "where did the time go" between VAD/STT/LLM.
    const transcriptionDelayMs: number[] = [];
    const endOfUtteranceDelayMs: number[] = [];

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      // ev.metrics is a discriminated union by `type`.
      const m = (ev as { metrics?: { type?: string } }).metrics;
      if (!m || typeof m !== 'object') return;
      const t = m.type;
      const r = m as Record<string, unknown>;
      if (t === 'realtime_model_metrics') {
        const ttft = Number(r['ttftMs']);
        if (Number.isFinite(ttft) && ttft > 0) ttftMsList.push(ttft);
        const dur = Number(r['durationMs']);
        if (Number.isFinite(dur) && dur > 0) responseDurationMs.push(dur);
        const inT = Number(r['inputTokens']);
        if (Number.isFinite(inT)) inputTokensTotal += inT;
        const inputDetails = r['inputTokenDetails'] as
          | { cachedTokens?: number }
          | undefined;
        if (inputDetails && Number.isFinite(inputDetails.cachedTokens)) {
          cachedInputTokens += Number(inputDetails.cachedTokens) || 0;
        }
      } else if (t === 'eou_metrics') {
        const td = Number(r['transcriptionDelayMs']);
        if (Number.isFinite(td) && td >= 0) transcriptionDelayMs.push(td);
        const eou = Number(r['endOfUtteranceDelayMs']);
        if (Number.isFinite(eou) && eou >= 0) endOfUtteranceDelayMs.push(eou);
      }
    });

    // Reset on any activity that means "the call is alive".
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, resetActivity);
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      const next = (ev as { newState?: string }).newState;
      const old = (ev as { oldState?: string }).oldState;
      if (next === 'speaking') resetActivity();
      // User just finished speaking → start the responsiveness timer.
      if (old === 'speaking' && (next === 'listening' || next === 'away')) {
        lastUserDoneAtMs = Date.now();
      }
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      const next = (ev as { newState?: string }).newState;
      // 'listening' is the idle state where we WANT to count silence — only
      // reset on 'speaking' / 'thinking' / 'initializing' which represent
      // active processing.
      if (next && next !== 'listening') resetActivity();
      // First time the agent starts speaking after session start = greeting.
      if (next === 'speaking' && greetingMs === null && sessionStartedAtMs !== null) {
        greetingMs = Date.now() - sessionStartedAtMs;
      }
      // Agent reply just started → close the per-turn responsiveness window.
      if (next === 'speaking' && lastUserDoneAtMs !== null) {
        wallclockTurnLatenciesMs.push(Date.now() - lastUserDoneAtMs);
        lastUserDoneAtMs = null;
      }
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
        "Termine l'appel proprement. À appeler UNIQUEMENT APRÈS avoir dit au revoir À VOIX HAUTE EN UNE SEULE PHRASE, quand la conversation est conclue (RDV pris/annulé/déplacé, info donnée et plus rien à demander, ou client a explicitement raccroché verbalement). Ne PAS appeler en plein milieu d'un échange. IMPORTANT : APRÈS l'appel à end_call, NE GÉNÈRE AUCUNE NOUVELLE RÉPONSE VOCALE — la ligne est en train de se fermer, tout son émis sera coupé.",
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
        // Don't close immediately — the LLM emits the tool call AT THE
        // SAME TIME as the goodbye audio. Wait for the agent state to
        // transition out of "speaking" (audio actually streamed), then
        // hold a small trailing window for the SIP RTP buffer to drain.
        // Hard cap is a safety net.
        let closed = false;
        const finish = (cause: string) => {
          if (closed) return;
          closed = true;
          setTimeout(
            () => void closeSession(`tool:${r}|${cause}`),
            END_CALL_TRAILING_MS,
          );
        };
        const stateHandler = (ev: {
          newState?: voice.AgentState;
          oldState?: voice.AgentState;
        }) => {
          if (
            ev.oldState === 'speaking' &&
            (ev.newState === 'listening' || ev.newState === 'idle')
          ) {
            session.off(
              voice.AgentSessionEventTypes.AgentStateChanged,
              stateHandler,
            );
            finish('speech_done');
          }
        };
        session.on(voice.AgentSessionEventTypes.AgentStateChanged, stateHandler);
        setTimeout(() => {
          session.off(
            voice.AgentSessionEventTypes.AgentStateChanged,
            stateHandler,
          );
          finish('hard_cap');
        }, END_CALL_HARD_CAP_MS);
        // Non-conversationnel exprès : si on retourne "Au revoir.", OpenAI
        // génère une nouvelle réponse vocale BASÉE sur ce résultat et
        // répète "Au revoir" 1-2 fois de plus avant la fermeture. Avec un
        // statut technique entre parenthèses + un guard sentence "ne parle
        // pas", le modèle s'abstient (testé : 3x → 1x au revoir).
        return '(call_closed) Ne génère aucune nouvelle réponse vocale, la ligne est en cours de fermeture.';
      },
    });

    // Greeting: prefer the tenant's stored greetingInstructions (editable
    // from /dashboard). Quand le tenant a rempli ce champ, le contenu est
    // la phrase d'accueil LITTÉRALE qu'on attend de la voix agent — pas
    // une directive. Sans wrapping explicite, le modèle traite ce
    // greetingInstructions comme un brief et improvise ("הבנתי, אני
    // אשמח לעזור..." au lieu de "שלום, כאן רוברט..."). On force donc le
    // "say textually" via prefix multi-langue qui couvre fr/he/en. Le
    // fallback (champ vide en DB) reste une directive ouverte parce qu'il
    // n'y a pas de phrase précise à prononcer.
    const customGreeting = cfg.greetingInstructions?.trim();
    const greetInstructions =
      customGreeting && customGreeting.length > 0
        ? `Commence ta première réponse en prononçant TEXTUELLEMENT, mot pour mot et dans la même langue, la phrase d'accueil ci-dessous (entre triple guillemets). Ne reformule pas, ne paraphrase pas cette phrase. PUIS, dans la même réponse vocale (même tour, sans attendre que l'interlocuteur parle), enchaîne directement avec la PREMIÈRE étape de ton persona/workflow — par exemple poser la question d'ouverture (« comment puis-je vous aider », « quel est votre nom », etc.) si ton persona l'exige. Reste fluide, comme un humain qui se présente et embraye sur sa première question naturellement.\n\nPhrase d'accueil littérale :\n"""\n${customGreeting}\n"""`
        : `Salue chaleureusement la cliente en te présentant : utilise ton prénom et le nom du centre tels que définis dans tes instructions système. Enchaîne immédiatement avec la première question/étape de ton persona — ne te contente pas d'un "comment puis-je vous aider", suis ce que ton persona décrit (ex. demander le nom). Si la cliente répond en hébreu, bascule en hébreu pour la suite de l'échange.`;

    // Programmatic language enforcement. gpt-realtime-mini has strong
    // language inertia — once warm on FR, it tends to keep replying FR
    // even after the user clearly switched to HE. The prompt's "PRIORITÉ
    // ABSOLUE" rule is regularly ignored. Belt+suspenders: hook the LLM
    // turn AFTER user transcription is committed but BEFORE the model
    // generates its reply, and inject a system message that forces the
    // language for THIS upcoming response. The model can't sandbag a
    // fresh system instruction the same way it sandbags the system prompt.
    class TenantAgent extends voice.Agent {
      private lastUserLang: 'he' | 'lat' | null = null;

      override async onEnter(): Promise<void> {
        // Inject the per-call dynamic context (today's date, caller phone)
        // as a system message at the START of chatCtx — visible to the
        // model for ALL subsequent turns, but OUTSIDE the cached prefix
        // (this.instructions stays 100% identical across calls for the
        // same tenant). Maximizes prompt cache hit rate.
        if (PER_CALL_CONTEXT.trim()) {
          const ctx = this.chatCtx.copy();
          ctx.addMessage({ role: 'system', content: PER_CALL_CONTEXT });
          await this.updateChatCtx(ctx);
        }
        await this.session.generateReply({
          instructions: greetInstructions,
        });
      }

      override async onUserTurnCompleted(
        chatCtx: import('@livekit/agents').llm.ChatContext,
        newMessage: import('@livekit/agents').llm.ChatMessage,
      ): Promise<void> {
        // Reuse the same probe that worked for UserInputTranscribed —
        // ChatContent items are { type:'audio', transcript:'…' } or
        // { type:'text', text:'…' } depending on the source.
        const text = extractText(newMessage.content).trim();
        if (!text) return;

        const hebrewChars = (text.match(/[֐-׿]/g) ?? []).length;
        const latinChars = (text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
        const userLang: 'he' | 'lat' =
          hebrewChars > latinChars && hebrewChars > 0 ? 'he' : 'lat';

        // Compact + transition-only : inject seulement quand la langue
        // user CHANGE vs le tour précédent (pas à chaque tour HE répété).
        // Économise des tokens non-cachés ET évite de polluer chatCtx.
        // 8 tokens vs 80 — la directive courte suffit (le system prompt
        // initial a déjà la règle complète, ceci est juste un rappel).
        if (userLang !== this.lastUserLang) {
          const directive =
            userLang === 'he'
              ? '🇮🇱 RÉPONDS EN HÉBREU.'
              : '🇫🇷 RÉPONDS DANS LA LANGUE DE LA CLIENTE.';
          chatCtx.addMessage({ role: 'system', content: directive });
          console.log(`[lang_enforce] transition → ${userLang}`);
        }

        this.lastUserLang = userLang;
      }
    }

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
      // Plan features → drive quels tools sont enregistrés (calendar/crm).
      // Si le tenant a calendar=false, le modèle ne verra même pas les
      // tools check_availability/book_appointment/... et ne pourra donc
      // pas les hallucinate.
      features: {
        calendar: cfg.features.calendar !== false,
        crm: cfg.features.crm !== false,
      },
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

    // Convert E.164 to Israeli local format for both speaking AND tool args.
    // +972585001007 → 0585001007. Customers dictate local format, store in
    // local format, agent reads local format.
    const localFromNumber = fromNumber.startsWith('+972')
      ? '0' + fromNumber.slice(4)
      : fromNumber;

    // Inject the caller's number (when known) so the LLM proposes it for
    // confirmation instead of asking blind. Withheld/private numbers leave
    // fromNumber empty → no hint → LLM asks like before.
    const callerHintBlock = localFromNumber
      ? `Le numéro qui appelle est : \`${localFromNumber}\` (format local, à utiliser tel quel pour les tools).

Avant d'utiliser ce numéro pour un tool (\`book_appointment\`, \`save_contact\`, etc.), CONFIRME-le avec la cliente — formule courte du genre :
  « Je note le rendez-vous au numéro qui appelle, le \`${localFromNumber}\`, c'est bien le bon ? »
ou en hébreu : « אני רושמת את התור על המספר שממנו את מתקשרת, \`${localFromNumber}\`, נכון? »

Rappel : prononce chiffre par chiffre par paires (voir directive ci-dessus), pas comme un grand nombre.

- Si elle confirme → utilise \`${localFromNumber}\` dans le champ \`phone\`.
- Si elle te donne un AUTRE numéro (elle appelle depuis le tel de sa mère, du bureau, etc.) → utilise celui qu'elle te dicte.

Tu n'as PAS besoin de demander son numéro de zéro — propose toujours \`${localFromNumber}\` pour confirmation d'abord, ça gagne du temps.`
      : '(Pas de numéro caller détecté — caller-ID withheld. Demande à la cliente son numéro normalement.)';

    // Fallback hardcodé si le web ne renvoie pas perCallContextTemplate
    // (ex. version /api/agent/config trop ancienne). Identique au default
    // côté web (lib/agent-prompt-defaults.ts DEFAULT_PER_CALL_CONTEXT_TEMPLATE).
    const FALLBACK_PCC_TEMPLATE = `
──────────────────────────────────────────
**CONTEXTE TEMPOREL (Asia/Jerusalem)**
- Aujourd'hui : {date_fr} (\`{iso_date}\`)
- Heure locale : {time}
- Fuseau de référence : Asia/Jerusalem (toutes les dates et heures que tu manipules sont dans ce fuseau)

Quand la cliente dit "demain", "lundi prochain", "dans 2 semaines", etc. → calcule la date YYYY-MM-DD à partir d'aujourd'hui ci-dessus AVANT d'appeler un tool. Ne demande JAMAIS la date complète à la cliente, ce serait étrange ("c'est quel jour aujourd'hui ?").
──────────────────────────────────────────

──────────────────────────────────────────
**NUMÉRO DU CLIENT (détecté via l'appel)**
{caller_hint_block}
──────────────────────────────────────────`;

    // Substitue les placeholders runtime dans le template per-call (édité
    // depuis /admin). Si le placeholder est absent, no-op silencieux.
    const pccTemplate = cfg.perCallContextTemplate?.trim() || FALLBACK_PCC_TEMPLATE;
    const PER_CALL_CONTEXT = pccTemplate
      .replaceAll('{date_fr}', nowJerusalem.dateFr)
      .replaceAll('{iso_date}', nowJerusalem.isoDate)
      .replaceAll('{time}', nowJerusalem.time)
      .replaceAll('{caller_hint_block}', callerHintBlock);

    // cfg.instructions vient déjà mergé depuis /api/agent/config — il inclut
    // les directives système (spoken_time, spoken_phone, hangup), la persona
    // tenant, la langue, et les règles admin par plan. On l'utilise direct.
    // Le worker ne hardcode plus aucun bloc système : tout est pilotable
    // depuis /admin.
    const STATIC_INSTRUCTIONS = cfg.instructions;

    const agent = new TenantAgent({
      instructions: STATIC_INSTRUCTIONS,
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
        inputOptions: {
          // ai-coustics Quail Voice Focus 2.1 L — UNIQUE étage de
          // noise reduction côté tel (OpenAI near_field désactivé
          // plus haut pour éviter double pass redondant).
          //   - enhancementLevel dérivé du slider 1-10 (cf. /dashboard
          //     "Réduction de bruit") : 1 ≈ 0.1 (quasi-passthrough),
          //     8 ≈ 0.8 (équilibré, recommandé téléphonie), 10 = 1.0
          //     (agressif, peut couper la queue de phonèmes).
          //   - VAD inhérent au modèle, tuné pour réponse rapide
          //     (speechHoldDuration 30ms, sensitivity 6.0).
          // Auth : LiveKit Cloud (notre setup) → pas besoin de license_key
          // ai-coustics séparée, c'est le plan-livekit-cloud qui couvre.
          noiseCancellation: audioEnhancement({
            model: 'quailVfL',
            modelParameters: {
              enhancementLevel: cfg.noiseReductionLevel / 10,
            },
            vadSettings: {
              speechHoldDuration: 0.03,
              sensitivity: 6.0,
              minimumSpeechDuration: 0.0,
            },
          }),
        },
      });
      // Mark the moment the session is ready — anything after this until the
      // first 'speaking' transition is the greeting latency.
      sessionStartedAtMs = Date.now();
      tSessionStarted = sessionStartedAtMs;
      await sessionClosed;
    } finally {
      clearInterval(silenceWatcher);
      // Ship enriched latency metrics. Pulls from BOTH:
      //   - Native LiveKit MetricsCollected events (TTFA = ttftMs canonique
      //     côté Realtime, EOU + transcription, cache hit ratio)
      //   - Wallclock fallback (greetingMs + per-turn) en cross-check
      //
      // Stats : moyenne, p50 (médiane), p95 sur les samples.
      const stats = (arr: number[]) => {
        if (arr.length === 0)
          return { count: 0, mean: null, p50: null, p95: null, max: null };
        const sorted = [...arr].sort((a, b) => a - b);
        const mean = Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
        const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? null;
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? null;
        const max = sorted[sorted.length - 1] ?? null;
        return {
          count: arr.length,
          mean,
          p50: p50 != null ? Math.round(p50) : null,
          p95: p95 != null ? Math.round(p95) : null,
          max: max != null ? Math.round(max) : null,
        };
      };

      const ttfa = stats(ttftMsList);
      const dur = stats(responseDurationMs);
      const eou = stats(endOfUtteranceDelayMs);
      const trans = stats(transcriptionDelayMs);
      const wall = stats(wallclockTurnLatenciesMs);
      // Métriques calculées depuis les events serveur OpenAI (cf. block
      // LoggingRealtimeModel) — remplacent les eou/trans du SDK qui ne
      // fire pas en mode Realtime.
      const serverEou = stats(serverEouDelayMs);
      const serverTrans = stats(serverTranscriptionDelayMs);
      const serverFirstAudio = stats(serverFirstAudioDelayMs);
      const cacheHitRatio = inputTokensTotal > 0
        ? Math.round((cachedInputTokens / inputTokensTotal) * 100)
        : null;
      const fmt = (ms: number | null) =>
        ms == null ? '?' : `${(ms / 1000).toFixed(2)}s`;
      const fmtMs = (ms: number | null) => (ms == null ? '?' : `${ms}ms`);

      // Préférer les métriques server-event quand dispo (Realtime mode),
      // sinon fallback sur SDK eou_metrics (mode STT séparé, hypothétique).
      const transMean = serverTrans.mean ?? trans.mean;
      const eouMean = serverEou.mean ?? eou.mean;

      // Phase breakdown (setup avant 1er audio) :
      //   connect = ctx.connect() LiveKit room
      //   sip = wait for SIP attributes (sip.trunkPhoneNumber)
      //   config = fetch /api/agent/config + parse
      //   session = session.start() (ouvre OpenAI WS + init session.update)
      const setupConnect = tConnectDone - phaseT0;
      const setupSip = tSipResolved - tConnectDone;
      const setupConfig = tConfigFetched - tSipResolved;
      const setupSession = tSessionStarted - tConfigFetched;
      const setupTotal = tSessionStarted - phaseT0;

      const summary =
        `⏱️ TTFA: ${fmtMs(ttfa.mean)} mean · ${fmtMs(ttfa.p95)} p95 (${ttfa.count} resp) · ` +
        `Greeting: ${fmt(greetingMs)} · ` +
        `Setup: ${fmtMs(setupTotal)} (connect ${fmtMs(setupConnect)} · sip ${fmtMs(setupSip)} · cfg ${fmtMs(setupConfig)} · sess ${fmtMs(setupSession)}) · ` +
        `Cache: ${cacheHitRatio == null ? 'n/a' : cacheHitRatio + '%'} hit · ` +
        `Trans: ${fmtMs(transMean)} · EOU: ${fmtMs(eouMean)} · ` +
        `FirstAudio: ${fmtMs(serverFirstAudio.mean)}`;

      await remoteLog('latency', 'call_metrics', summary, 'info', {
        // Headline KPIs (the user-perceived numbers)
        ttfaMs: ttfa,
        responseDurationMs: dur,
        greetingMs,
        // Breakdown KPIs — server-event measurements (Realtime mode)
        serverTranscriptionDelayMs: serverTrans,
        serverEouDelayMs: serverEou,
        serverFirstAudioDelayMs: serverFirstAudio,
        // Legacy SDK metrics — laissés pour comparaison ; en Realtime mode
        // ces arrays restent vides parce que le SDK ne mesure pas EOU/STT.
        endOfUtteranceDelayMs: eou,
        transcriptionDelayMs: trans,
        wallclockTurnLatenciesMs: wall,
        // Cache effectiveness — confirms the static-prefix optimization
        promptCache: {
          inputTokensTotal,
          cachedInputTokens,
          cacheHitRatio,
        },
        // Routing context for filtering in /dashboard/logs
        fromNumber,
        toNumber,
        // Setup phase breakdown : où le temps part avant le greeting.
        setupMs: {
          connect: setupConnect,
          sipWait: setupSip,
          configFetch: setupConfig,
          sessionStart: setupSession,
          total: setupTotal,
        },
        // Raw arrays for power-user debug
        rawTtftMs: ttftMsList,
        rawServerEouMs: serverEouDelayMs,
        rawServerTransMs: serverTranscriptionDelayMs,
      });
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
