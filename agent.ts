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
  REALTIME_CONFIG,
} from './config.js';
import { fetchConfig } from './src/config-fetcher.js';
import {
  END_CALL_HARD_CAP_MS,
  END_CALL_TRAILING_MS,
  MAX_CALL_DURATION_MS,
  SILENCE_GRACE_START_MS,
  SILENCE_HANGUP_MS,
} from './src/constants.js';
import { requireEnv } from './src/env.js';
import { fetchOpenerPcm, pcmToFrameStream } from './src/greeting-player.js';
import { sniffLang } from './src/lang-sniff.js';
import { detectOrigin, sipFromOf, sipToOf } from './src/origin.js';
import { buildPerCallContext } from './src/per-call-context.js';
import { toIsraeliLocal } from './src/phone.js';
import { postCallEnd, postCampaignResult } from './src/post-call.js';
import { computeRealtimeCostUsd } from './src/pricing.js';
import { probeRegionsAtStartup } from './src/region-probe.js';
import { enterSession, remoteLog } from './src/remote-log.js';
import { extractText } from './src/transcript.js';
import type {
  ProcessUserData,
  TranscriptEntry,
} from './src/types.js';
import { makeBusinessTools } from './tools/business.js';
import { makeCalendarTools } from './tools/calendar.js';
import { makeKnowledgeTools } from './tools/knowledge.js';

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
    // Fail-fast : valider la clé API Realtime AVANT qu'un appel sonne.
    // Sans clé, chaque appel entrant crasherait au moment de construire le
    // RealtimeModel (client entend du silence puis raccroche). Throw ici =
    // le worker ne s'enregistre pas auprès de LiveKit → l'erreur est
    // visible au boot Railway, pas au premier appel. Le requireEnv per-call
    // dans entry() est conservé (belt & braces).
    if (!process.env['REALTIME_API_KEY']) requireEnv('OPENAI_API_KEY');

    // Probe région : mesure RTT réels depuis le container LK Cloud Agent
    // vers Twilio / LK SFU / OpenAI / Web. Loggé dans /dashboard/logs
    // sous l'event `infra_region_probe` pour corréler env INFRA_* vs réalité.
    // Best-effort, ne bloque pas le boot si ça foire.
    try {
      await probeRegionsAtStartup();
    } catch (e) {
      console.warn('[region-probe] failed:', (e as Error).message);
    }
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

    // Instrumentation détaillée du connect — décompose les phases pour
    // identifier où passent les 400-600ms du `setupConnect`. Capture les
    // events Room qui fire pendant ctx.connect() : Connected (= signaling
    // + ICE + DTLS done), RoomSidChanged (= SFU node assigned us).
    const connectPhases: Record<string, number> = {};
    const markConnectPhase = (label: string) => {
      if (connectPhases[label] === undefined) {
        connectPhases[label] = Date.now() - phaseT0;
      }
    };
    ctx.room.once(RoomEvent.RoomSidChanged, () => markConnectPhase('roomSidAssigned'));
    ctx.room.once(RoomEvent.Connected, () => markConnectPhase('connectedEvent'));
    ctx.room.once(RoomEvent.Reconnecting, () => markConnectPhase('reconnecting'));
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    tConnectDone = Date.now();
    markConnectPhase('ctxConnectReturned');
    // Capture room metadata + participant list for diagnostics
    const roomSid = await ctx.room.getSid().catch(() => null);
    const roomDiag = {
      sid: roomSid,
      name: ctx.room.name,
      serverUrl: ctx.room.serverUrl ?? null,
      remoteParticipantCount: ctx.room.remoteParticipants.size,
    };
    void remoteLog(
      'latency',
      'connect_phases',
      `Connect breakdown · ${Object.entries(connectPhases).map(([k,v]) => `${k}=${v}ms`).join(' · ')} · room=${roomDiag.name}`,
      'info',
      { phases: connectPhases, totalMs: tConnectDone - phaseT0, room: roomDiag },
    );

    // Résout l'origine (SIP Twilio ou Web LiveTest) AVANT le fetch config.
    // Les attributes/metadata arrivent un beat après `connect()` — on
    // wait briefly. Réduit à 1.5s : sur les tests prod les attrs SIP
    // arrivent en <500ms. Au-delà de 1.5s on tombe sur 'unknown' →
    // fetchConfig fallback default-tenant.
    const origin = await detectOrigin(ctx, 1_500);
    tSipResolved = Date.now();
    // Propage origin à tous les remoteLog suivants via AsyncLocalStorage —
    // permet à lib/logger.ts côté web de résoudre user_id même sur les
    // events qui ne portent pas de toNumber (config_loaded, auto_hangup,
    // realtime_server_error, call_ended, etc.) sans avoir à les passer
    // explicitement à chaque appel.
    enterSession({ origin });
    const originLabel =
      origin.kind === 'sip'
        ? `${origin.channel === 'whatsapp' ? 'WA' : 'SIP'} ${origin.calledNumber}`
        : origin.kind === 'web'
          ? `Web user ${origin.userId}`
          : '(origine inconnue)';
    // fire-and-forget : ne jamais bloquer le chemin d'appel sur la télémétrie
    void remoteLog(
      'agent',
      'call_started',
      `Session démarrée — ${originLabel}`,
      'info',
      { origin, roomName: ctx.room.name },
    );

    const cfg = await fetchConfig(origin);
    tConfigFetched = Date.now();
    // fire-and-forget : ne jamais bloquer le chemin d'appel sur la télémétrie
    void remoteLog(
      'agent',
      'config_loaded',
      `Config chargée : ${cfg.model} / ${cfg.voice} / t°${cfg.temperature}`,
      'info',
      { model: cfg.model, voice: cfg.voice, temperature: cfg.temperature },
    );

    // Accueil instantané : on lance le fetch de l'opener pré-généré DÈS
    // maintenant (en parallèle du reste du setup) pour qu'il soit prêt à
    // l'entrée de l'agent. SIP uniquement (l'endpoint route par numéro).
    // null si indispo → onEnter retombe sur l'accueil modèle.
    const dialedNumber =
      origin.kind === 'sip' ? origin.calledNumber : '';
    // creds APP_URL/INTERNAL_SECRET désormais injectés par src/web-api.ts
    const openerPromise = dialedNumber
      ? fetchOpenerPcm(dialedNumber).catch(() => null)
      : Promise.resolve(null);

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
    // Captured ref vers la RealtimeSession active pour pouvoir lui
    // envoyer des ClientEvent custom (session.update temperature à chaud,
    // notamment). Set par LoggingRealtimeModel.session() override.
    let capturedRtSession: openai.realtime.RealtimeSession | null = null;

    class LoggingRealtimeModel extends openai.realtime.RealtimeModel {
      override session(): openai.realtime.RealtimeSession {
        const sess = super.session();
        capturedRtSession = sess;
        sess.on('openai_server_event_received', (event: unknown) => {
          const e = event as {
            type?: string;
            error?: { code?: string; message?: string; param?: string };
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
              const errCode = e.error?.code ?? '';
              const errMsg = e.error?.message ?? 'erreur inconnue';
              // Codes bénins : races entre cancel/response côté SDK et
              // OpenAI. Le response.cancel envoyé après la fin d'une
              // response est rejeté mais sans impact runtime. On garde la
              // trace visible en `warn` (orange) pour qu'on puisse
              // toujours diagnostiquer sans le confondre avec les vraies
              // anomalies (rouge).
              const BENIGN_ERROR_CODES = new Set([
                'response_cancel_not_active',
              ]);
              const isBenign = BENIGN_ERROR_CODES.has(errCode);
              if (isBenign) {
                void remoteLog(
                  'agent',
                  'realtime_server_warning',
                  `OpenAI bénin (${errCode}) : ${errMsg.slice(0, 200)}`,
                  'warn',
                  { rawEvent: event },
                );
                break;
              }
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

    // On garde une ref au LoggingRealtimeModel pour pouvoir lui envoyer
    // un session.update à chaud après start (cf. plus bas — pilote la
    // temperature même si le constructor refuse de la prendre).
    const rtModel = new LoggingRealtimeModel({
      apiKey,
      baseURL: REALTIME_CONFIG.apiBase,
      model: cfg.model,
      modalities: [...REALTIME_CONFIG.modalities],
      voice: cfg.voice,
      // temperature : pas dans le constructor (deprecated dans GA), on
      // tente un session.update à chaud après que la session se connecte.
      speed: cfg.speed,
      // maxResponseOutputTokens : SDK default = 'inf'. On a tenté un cap
      // 220 (tunable depuis admin) le 12/05/26 — ça coupait le greeting
      // mid-phrase. La longueur de réponse est désormais gouvernée
      // uniquement par le prompt (cf. INSTRUCTIONS "max 1-2 phrases").
      inputAudioTranscription: {
        model: REALTIME_CONFIG.transcriptionModel,
        // Language hint pour le STT — sinon le modèle invente chinois/coréen
        // dès qu'un mot n'est pas reconnu (observé en prod : audio hébreu
        // mal transcrit en "等一下", "啾啾", "Machalt", etc.). Le primaryLanguage
        // du tenant guide le STT — 'he', 'fr', 'en'. Le LLM continue à
        // détecter changes de langue à l'oreille, mais le transcript text
        // est correctement étiqueté.
        language: (cfg.primaryLanguage ?? 'fr') as 'he' | 'fr' | 'en',
      },
      // inputAudioNoiseReduction RETIRÉ — ai-coustics Quail Voice
      // Focus 2.1 L (cf. inputOptions.noiseCancellation plus bas) gère
      // toute la noise reduction côté worker AVANT que l'audio atteigne
      // OpenAI. Double pass redondant + ajoutait ~5-10ms de latence
      // inutile + altérait parfois la queue de phonèmes déjà bien isolée.
      // Optims latence aggressives (cible : TTFA p50 ~550ms, p95 <1100ms) :
      // - threshold 0.75 : VAD très confiant, ignore plus de bruits courts
      // - silence_duration_ms 350 : l'agent répond ~130ms plus vite après
      //   la fin de phrase user (vs 480 avant).
      // - prefix_padding_ms 150 : moins de buffer avant détection.
      // - create_response: true : l'API génère la réponse directement à
      //   la fin du tour user, sans attendre un trigger explicite.
      turnDetection: {
        type: 'server_vad',
        threshold: 0.75,
        prefix_padding_ms: 150,
        silence_duration_ms: 350,
        create_response: true,
      },
    });

    const session = new voice.AgentSession({
      // Pas de VAD local (Silero retiré car saturait le CPU du worker).
      // OpenAI server_vad gère la détection de tour côté serveur.
      llm: rtModel,
    });

    // ── Transcript capture ──────────────────────────────────────────────
    const transcript: TranscriptEntry[] = [];
    let fromNumber = '';
    let toNumber = origin.kind === 'sip' ? origin.calledNumber : '';
    let recapSent = false;

    /**
     * Capture les numéros SIP (From/To) depuis les attributes d'un
     * participant remote et met à jour `fromNumber`/`toNumber`.
     *
     * Contrat :
     *   - Synchrone, n'await rien, ne throw jamais (lecture d'attributes).
     *   - Idempotent : ré-appelable à chaque event participant ; n'écrase
     *     une valeur déjà capturée QUE si l'attribute est présent (un
     *     event tardif sans attrs ne vide pas un numéro déjà résolu).
     *   - Safe à appeler à tout moment après `ctx.connect()` — branché sur
     *     ParticipantConnected + ParticipantAttributesChanged car les
     *     attrs SIP arrivent souvent APRÈS la connexion (race Twilio).
     */
    const captureNumbers = (p: {
      attributes: Record<string, string>;
      identity: string;
    }) => {
      const f = sipFromOf(p);
      const t = sipToOf(p);
      if (f) fromNumber = f;
      // t.calledNumber = numéro nu (préfixe `whatsapp:` retiré) — cohérent
      // avec l'init depuis origin.calledNumber et avec ce qu'on POST à
      // /api/calls/end (jamais le préfixe whatsapp:).
      if (t.raw) toNumber = t.calledNumber;
    };
    for (const [, p] of ctx.room.remoteParticipants) captureNumbers(p);
    ctx.room.on(RoomEvent.ParticipantConnected, (p) => captureNumbers(p));
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
      captureNumbers(p);
    });

    /**
     * Publie un tour de transcript sur le data channel de la room pour que
     * la UI navigateur (LiveTest entrant / test live d'agent sortant)
     * affiche la transcription en temps réel. Encodage JSON utf-8 simple.
     *
     * Contrat :
     *   - No-op pour les origines non-web (SIP/campagne : Twilio n'écoute
     *     pas le data channel).
     *   - Best-effort, ne throw jamais (publishData wrappé try/catch) et
     *     n'await rien — `publishData` est fire-and-forget côté SDK.
     *   - Safe à appeler à tout moment, y compris pendant la fermeture
     *     (un publish raté est juste warn en console).
     */
    const publishWebTranscript = (entry: TranscriptEntry) => {
      // Web (LiveTest entrant) ET test live d'agent sortant : la UI navigateur
      // affiche la transcription via le data channel.
      if (origin.kind !== 'web' && origin.kind !== 'outbound_test') return;
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
      // Sniff charset cheap : log le script dominant pour vérifier après
      // coup que les tours hébreux sont transcrits en hébreu, pas en
      // charabia français (whisper-1 faisait ça). Unifié (2026-06) sur la
      // variante STRICTE de src/lang-sniff.ts — même fonction que le
      // language-enforcement de onUserTurnCompleted.
      const langSniff = sniffLang(text) ?? '?';
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
    /**
     * Déclenche le pipeline post-appel selon l'origine : campagne →
     * `/api/agent/campaign-result`, inbound (SIP/web) → `/api/calls/end`,
     * test live → rien.
     *
     * Contrat :
     *   - Idempotent : le flag `recapSent` garantit un seul envoi même si
     *     appelé plusieurs fois (Close event + finally).
     *   - Awaité jusqu'au POST final inclus (retries/backoff compris, cf.
     *     src/post-call.ts) — l'appelant DOIT await pour ne pas tuer le
     *     process avant l'envoi. Ne throw jamais (postCallEnd /
     *     postCampaignResult sont best-effort avec dump de recovery).
     *   - Safe à appeler dès que `transcript`/`fromNumber`/`toNumber` sont
     *     déclarés ; en pratique appelé uniquement dans le finally de
     *     entry() une fois la session fermée.
     */
    const triggerRecap = async () => {
      if (recapSent) return;
      recapSent = true;
      // Test live d'un agent (dashboard) → aucun recap ni persistance.
      if (origin.kind === 'outbound_test') return;
      // Appel sortant de campagne → résultat vers /api/agent/campaign-result
      // (analyse IA + transition contact côté web), pas le pipeline inbound.
      if (origin.kind === 'campaign') {
        await postCampaignResult(
          origin.campaignId,
          origin.contactId,
          transcript,
          Math.round((Date.now() - sessionStartedAt) / 1000),
        );
        return;
      }
      await postCallEnd(
        transcript,
        fromNumber,
        toNumber,
        origin.kind === 'web' ? origin.userId : undefined,
        origin.kind === 'sip' ? origin.channel : undefined,
      );
    };

    // ── Auto-hangup ─────────────────────────────────────────────────────
    // Two triggers:
    //   1. The LLM calls the `end_call` tool when the conversation is done.
    //   2. No activity (user speech / agent speech / tool execution) for
    //      SILENCE_HANGUP_MS — the call is dead, hang up.
    const sessionStartedAt = Date.now();
    let lastActivity = sessionStartedAt;
    let closing = false;
    // État courant de l'agent. Tant que l'agent parle/réfléchit (≠ 'listening'),
    // on ne compte PAS de silence — sinon un long monologue (ex. argumentaire de
    // vente > SILENCE_HANGUP_MS) déclenchait un auto_hangup en plein milieu.
    let agentState = 'initializing';
    const resetActivity = () => {
      lastActivity = Date.now();
    };
    /**
     * Ferme la session ET raccroche réellement la ligne (deleteRoom — sans
     * ça Twilio garde la ligne SIP ouverte et facture).
     *
     * Contrat :
     *   - Idempotent : le guard `closing` rend tout appel concurrent ou
     *     répété no-op — safe depuis le watchdog, end_call, le catch de
     *     session.start(), etc., sans coordination.
     *   - Awaité : `session.close()` puis `svc.deleteRoom()`. Les deux sont
     *     wrappés try/catch → la fonction ne throw jamais.
     *   - La télémétrie (`auto_hangup`) est fire-and-forget, jamais sur le
     *     chemin de fermeture.
     *   - Safe à appeler à TOUT moment après la création de `session`,
     *     y compris si `session.start()` n'a jamais abouti.
     */
    const closeSession = async (reason: string) => {
      if (closing) return;
      closing = true;
      // fire-and-forget : ne jamais bloquer le chemin d'appel sur la télémétrie
      void remoteLog(
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
    // Posé APRÈS session.start() (session prête à parler) — à ne pas
    // confondre avec `sessionStartedAt` (début d'appel, base des watchdogs).
    let sessionReadyAtMs: number | null = null;
    let greetingMs: number | null = null;
    // 'prerendered' = accueil joué via session.say (audio pré-généré), 'model'
    // = accueil généré par le LLM (fallback). Loggé dans call_metrics.
    let greetingSource: 'prerendered' | 'model' = 'model';
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
    let outputTokensTotal = 0;
    // Breakdown audio/texte/cached pour le calcul de coût USD (cf. src/pricing).
    // L'audio domine le coût ; les tarifs audio/texte/cached diffèrent d'un
    // ordre de grandeur → on accumule chaque bucket séparément par tour.
    let inAudioTokens = 0;
    let inTextTokens = 0;
    let inCachedAudioTokens = 0;
    let inCachedTextTokens = 0;
    let outAudioTokens = 0;
    let outTextTokens = 0;
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
        const outT = Number(r['outputTokens']);
        if (Number.isFinite(outT)) outputTokensTotal += outT;
        const inputDetails = r['inputTokenDetails'] as
          | {
              audioTokens?: number;
              textTokens?: number;
              cachedTokens?: number;
              cachedTokensDetails?: { audioTokens?: number; textTokens?: number };
            }
          | undefined;
        if (inputDetails) {
          const cached = Number(inputDetails.cachedTokens) || 0;
          if (Number.isFinite(cached)) cachedInputTokens += cached;
          inAudioTokens += Number(inputDetails.audioTokens) || 0;
          inTextTokens += Number(inputDetails.textTokens) || 0;
          const cd = inputDetails.cachedTokensDetails;
          if (cd) {
            // Split cached connu → exact.
            inCachedAudioTokens += Number(cd.audioTokens) || 0;
            inCachedTextTokens += Number(cd.textTokens) || 0;
          } else {
            // Fallback : le cache Realtime porte sur le prompt (texte).
            inCachedTextTokens += cached;
          }
        }
        const outputDetails = r['outputTokenDetails'] as
          | { audioTokens?: number; textTokens?: number }
          | undefined;
        if (outputDetails) {
          outAudioTokens += Number(outputDetails.audioTokens) || 0;
          outTextTokens += Number(outputDetails.textTokens) || 0;
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
      if (next) agentState = next;
      // 'listening' is the idle state where we WANT to count silence — only
      // reset on 'speaking' / 'thinking' / 'initializing' which represent
      // active processing.
      if (next && next !== 'listening') resetActivity();
      // First time the agent starts speaking after session start = greeting.
      if (next === 'speaking' && greetingMs === null && sessionReadyAtMs !== null) {
        greetingMs = Date.now() - sessionReadyAtMs;
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
      // Hard-cap durée d'appel : au-delà de MAX_CALL_DURATION_MS, c'est
      // presque toujours une ligne zombie (SIP pas raccroché, boucle LLM)
      // qui facture Twilio + OpenAI pour rien. Même chemin de fermeture
      // que le silence, quel que soit l'état de l'agent.
      if (Date.now() - sessionStartedAt > MAX_CALL_DURATION_MS) {
        clearInterval(silenceWatcher);
        void closeSession('max_duration');
        return;
      }
      // Grace period at the start: don't hang up just because the customer
      // takes a beat to respond to the greeting.
      if (Date.now() - sessionStartedAt < SILENCE_GRACE_START_MS) return;
      // L'agent parle ou réfléchit (ex. long argumentaire) → ce n'est pas du
      // silence. On garde la ligne vivante et on remet le compteur à zéro.
      if (agentState !== 'listening') {
        resetActivity();
        return;
      }
      if (Date.now() - lastActivity > SILENCE_HANGUP_MS) {
        clearInterval(silenceWatcher);
        void closeSession(`silence_${SILENCE_HANGUP_MS}ms`);
      }
    }, 2_000);

    // ── end_call tool — exposed to the LLM ──────────────────────────────
    const endCallTool = llm.tool({
      description:
        "Termine l'appel et raccroche. À appeler UNIQUEMENT dans le MÊME tour de parole où tu viens de dire au revoir À VOIX HAUTE, EN UNE SEULE PHRASE COURTE et DANS LA LANGUE DU CLIENT — et seulement quand la conversation est réellement finie : RDV pris/annulé/déplacé, info donnée et plus rien à demander, le client dit au revoir ou demande à raccrocher, ou silence persistant après une relance. Ne PAS appeler en plein milieu d'un échange ni pendant une simple pause ; si le client reparle pendant que tu conclus, n'appelle PAS end_call et reprends la conversation. Garde le au revoir COURT : un au revoir long ou bavard augmente le risque que ce raccroché soit perdu et que la ligne reste ouverte. APRÈS end_call, NE GÉNÈRE PLUS AUCUNE PAROLE — la ligne se ferme, tout son émis sera coupé.",
      parameters: z.object({
        reason: z
          .string()
          .nullish()
          .describe(
            "Raison courte du raccroché : 'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'information_given', 'client_requested_hangup', 'no_response', 'voicemail'.",
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
        // Id du setTimeout hard-cap — clear dans finish() quand le chemin
        // nominal (speech_done) gagne, pour ne pas laisser un timer mort.
        let hardCapTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (cause: string) => {
          if (closed) return;
          closed = true;
          if (hardCapTimer !== undefined) clearTimeout(hardCapTimer);
          // Le résultat du tool est réinjecté au LLM, qui génère une réponse
          // de suivi → l'agent redit "au revoir" une fois de trop avant la
          // fermeture. Une fois l'au revoir réellement prononcé, on coupe
          // toute génération en cours/à venir avant de fermer la ligne.
          try {
            session.interrupt();
          } catch {
            /* best-effort */
          }
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
        hardCapTimer = setTimeout(() => {
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
    // Nom de l'agent à substituer dans le template fallback admin.
    const namePart =
      cfg.agentName && cfg.agentName.trim().length > 0
        ? `« ${cfg.agentName.trim()} »`
        : 'défini dans tes instructions système';
    // Fallback per-plan édité depuis /admin (cf. settings.GREETING_FALLBACK_TEMPLATE_BY_PLAN).
    // CHANGEMENT (2026-05-15) : si l'admin n'a rien renseigné ET le tenant
    // n'a pas de greeting_instructions, on N'INJECTE RIEN — le persona du
    // tenant gère lui-même sa première réponse. Avant on injectait un
    // fallback hardcoded "Salue par ton prénom..." qui override silencieusement
    // les personae customs (ex. REGLE_STRICTE répète X mot pour mot).
    const adminFallback =
      cfg.greetingFallbackTemplate && cfg.greetingFallbackTemplate.trim().length > 0
        ? cfg.greetingFallbackTemplate.replace(/\{agent_name\}/g, namePart)
        : '';
    const greetInstructions =
      customGreeting && customGreeting.length > 0
        ? `Commence ta première réponse en prononçant TEXTUELLEMENT, mot pour mot et dans la même langue, la phrase d'accueil ci-dessous (entre triple guillemets). Ne reformule pas, ne paraphrase pas cette phrase. PUIS, dans la même réponse vocale (même tour, sans attendre que l'interlocuteur parle), enchaîne directement avec la PREMIÈRE étape de ton persona/workflow — par exemple poser la question d'ouverture (« comment puis-je vous aider », « quel est votre nom », etc.) si ton persona l'exige. Reste fluide, comme un humain qui se présente et embraye sur sa première question naturellement.\n\nPhrase d'accueil littérale :\n"""\n${customGreeting}\n"""`
        : adminFallback;

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
        // ── Accueil INSTANTANÉ pré-généré ──────────────────────────────────
        // Si un opener audio est dispo (voix exacte, généré côté web), on le
        // joue via session.say au lieu de laisser le modèle générer l'accueil
        // (~2s de prefill/TTFA). On gèle l'entrée pendant la lecture (pas de
        // faux turn / echo), et addToChatCtx ajoute le texte de l'opener au
        // chatCtx → le modèle SAIT qu'il a accueilli et ne resalue pas ; il
        // reste silencieux jusqu'au 1er tour client.
        const opener = await openerPromise;
        if (opener) {
          try {
            this.session.input.setAudioEnabled(false);
            const handle = this.session.say(opener.text, {
              audio: pcmToFrameStream(opener.pcm, opener.sampleRate),
              addToChatCtx: true,
            });
            // Garde-fou : ne jamais bloquer l'appel si waitForPlayout hangait.
            await Promise.race([
              handle.waitForPlayout(),
              new Promise((r) => setTimeout(r, 15000)),
            ]);
            greetingSource = 'prerendered';
            return;
          } catch (e) {
            void remoteLog(
              'agent',
              'greeting_prerender_failed',
              `Lecture opener pré-généré échouée : ${(e as Error)?.message ?? e}`,
              'warn',
              {},
            );
            // → on retombe sur l'accueil modèle ci-dessous.
          } finally {
            this.session.input.setAudioEnabled(true);
          }
        }

        // ── Fallback : accueil par le modèle (comportement historique) ─────
        // PER_CALL_CONTEXT est injecté dans le chatCtx INITIAL (constructeur),
        // donc envoyé pendant session.start(). Si greetInstructions est vide,
        // generateReply sans override → le LLM ouvre selon son persona.
        if (greetInstructions.length > 0) {
          await this.session.generateReply({
            instructions: greetInstructions,
          });
        } else {
          await this.session.generateReply();
        }
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

        // Variante STRICTE de src/lang-sniff.ts (hébreu seulement si
        // majoritaire ET présent) — unifiée avec le log [lang_sniff] de
        // UserInputTranscribed. `null` (aucun char alphabétique : chiffres,
        // ponctuation) → 'lat', comme l'inline historique.
        const userLang: 'he' | 'lat' = sniffLang(text) ?? 'lat';

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
    // tenantUserId : pour web LiveTest sessions, toNumber est vide.
    // On dérive du origin.userId (résolu par detectOrigin) pour que le
    // web puisse router vers le bon Google calendar via x-tenant-user-id.
    const tenantUserId = origin.kind === 'web' ? origin.userId : '';
    const calendarTools = makeCalendarTools({
      dialedPhone: toNumber,
      // Live getter — les attrs SIP peuvent arriver APRÈS la construction
      // des tools (et après le timeout de detectOrigin) : un `dialedPhone`
      // capturé par valeur resterait vide → x-tenant-phone manquant →
      // fallback cross-tenant côté web. Lu au moment de chaque requête,
      // miroir exact du pattern getCallerPhone.
      getDialedPhone: () => toNumber,
      tenantUserId,
      // Live getter — fromNumber may arrive AFTER tools are built (SIP attrs
      // race). Convert +972 → 0 here too so the WhatsApp the owner reads
      // shows the local format directly.
      getCallerPhone: () => toIsraeliLocal(fromNumber),
      // Plan features → drive quels tools sont enregistrés (calendar/crm).
      // Si le tenant a calendar=false, le modèle ne verra même pas les
      // tools check_availability/book_appointment/... et ne pourra donc
      // pas les hallucinate.
      features: {
        calendar: cfg.features.calendar !== false,
        crm: cfg.features.crm !== false,
      },
    });

    // Numéro de l'appelant en format local israélien (+972… → 0…) — les
    // clientes dictent/écoutent en local, les tools stockent en local.
    const localFromNumber = toIsraeliLocal(fromNumber);

    // Contexte per-call (date/heure Jérusalem + caller-hint substitués dans
    // le template per-plan ou le fallback) — assemblé par
    // src/per-call-context.ts, extrait verbatim de l'inline historique.
    const { perCallContext: PER_CALL_CONTEXT, callerHintBlock } =
      buildPerCallContext(localFromNumber, cfg.perCallContextTemplate);

    // cfg.instructions vient déjà mergé depuis /api/agent/config — il inclut
    // les directives système (spoken_time, spoken_phone, hangup), la persona
    // tenant, la langue, et les règles admin par plan. On l'utilise direct.
    // Le worker ne hardcode plus aucun bloc système : tout est pilotable
    // depuis /admin.
    const STATIC_INSTRUCTIONS = cfg.instructions;

    // Tools business structurés (list_centres, get_centre_info,
    // get_opening_hours, list_services, find_service) — depuis la struct
    // `agent_configs.business` du tenant. 5 tools fixes (un par opération)
    // au lieu d'un tool par business comme le legacy `knowledge`.
    // Construits UNE fois — réutilisés pour le log chatctx_snapshot ET
    // l'enregistrement sur l'agent.
    const businessTools = makeBusinessTools(cfg.business);
    const businessNames = Object.keys(businessTools);
    if (businessNames.length > 0) {
      void remoteLog(
        'agent',
        'business_tools_registered',
        `Tools business enregistrés : ${businessNames.join(', ')}`,
        'info',
        { count: businessNames.length, names: businessNames },
      );
    }

    // Tools legacy `knowledge` — gardés en parallèle pour fallback si le
    // tenant n'a pas encore migré vers business. À droper en release N+1.
    const knowledgeTools = makeKnowledgeTools(cfg.knowledge);
    const knowledgeNames = Object.keys(knowledgeTools);
    if (knowledgeNames.length > 0) {
      void remoteLog(
        'agent',
        'knowledge_tools_registered',
        `Tools knowledge (legacy) enregistrés : ${knowledgeNames.join(', ')}`,
        'info',
        { count: knowledgeNames.length, names: knowledgeNames },
      );
    }

    // Snapshot du contexte LLM pour audit/debug dans /dashboard/logs.
    // Cet event matérialise ce qui sera EXACTEMENT envoyé à OpenAI :
    //   - systemPrompt : `STATIC_INSTRUCTIONS` (= cfg.instructions assemblé
    //     côté /api/agent/config). Sert de base immutable pour la session.
    //   - perCallContext : `PER_CALL_CONTEXT` (= template avec placeholders
    //     substitués : date, heure, caller_hint_block). Injecté au début
    //     du chatCtx comme system message.
    //   - greetingInstructions : phrase d'accueil littérale.
    // Loggé une seule fois par session — taille typique 8-12kB metadata.
    void remoteLog(
      'agent',
      'chatctx_snapshot',
      `ChatCtx assemblé · system ${STATIC_INSTRUCTIONS.length} chars · per-call ${PER_CALL_CONTEXT.length} chars`,
      'info',
      {
        systemPrompt: STATIC_INSTRUCTIONS,
        perCallContext: PER_CALL_CONTEXT,
        greetingInstructions: cfg.greetingInstructions,
        callerHintBlock,
        fromNumber: localFromNumber || null,
        toNumber: toNumber || null,
        sessionStartedAt: new Date().toISOString(),
        // Tools registrés visibles par le LLM (built-in + knowledge)
        toolsRegistered: [
          ...(cfg.features.calendar !== false
            ? [
                'list_available_dates',
                'check_availability',
                'book_appointment',
                'save_contact',
                'find_appointment',
                'cancel_appointment',
                'reschedule_appointment',
              ]
            : []),
          ...businessNames,
          ...knowledgeNames,
          'end_call',
        ],
      },
    );

    // chatCtx initial : on y place le PER_CALL_CONTEXT (system message) pour
    // qu'il soit synchronisé pendant session.start() au lieu d'un round-trip
    // séparé en onEnter (gain sur greetingMs / E2E init). `instructions` reste
    // STATIC_INSTRUCTIONS → prefix caché identique d'un appel à l'autre.
    const initialChatCtx = llm.ChatContext.empty();
    if (PER_CALL_CONTEXT.trim()) {
      initialChatCtx.addMessage({ role: 'system', content: PER_CALL_CONTEXT });
    }

    const agent = new TenantAgent({
      instructions: STATIC_INSTRUCTIONS,
      chatCtx: initialChatCtx,
      tools: {
        ...calendarTools,
        ...businessTools,
        ...knowledgeTools,
        end_call: endCallTool,
      },
    });

    // Wait until the session actually emits Close (caller hung up OR we
    // closed it ourselves via end_call/silence). session.start() resolves
    // on setup, NOT on call end — register the one-shot Close listener now.
    const sessionClosed = new Promise<void>((resolve) => {
      session.once(voice.AgentSessionEventTypes.Close, () => resolve());
    });

    try {
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
      } catch (e) {
        // session.start() a échoué (WS OpenAI refusée, room déjà fermée,
        // modèle inexistant, etc.) — sans fermeture explicite, la room
        // LiveKit resterait ouverte et l'appelant entendrait du silence
        // pendant que Twilio facture. closeSession est idempotent (guard
        // `closing`) → safe ici même si la session n'a jamais émis d'event.
        void remoteLog(
          'agent',
          'session_start_failed',
          `session.start() a échoué : ${(e as Error)?.message ?? String(e)}`,
          'error',
          {},
        );
        await closeSession('start_failed');
        throw e;
      }

      // NB : on n'envoie PLUS de session.update temperature ici. OpenAI
      // Realtime GA a retiré le param (`Unknown parameter: 'session.temperature'`)
      // → l'event était rejeté à CHAQUE appel (bruit de logs) ET partait pile
      // au moment où l'accueil se génère : un session.update concurrent à la
      // réponse en cours peut retarder le 1er audio (greetingMs). On le retire.
      // `capturedRtSession` reste capturé (LoggingRealtimeModel) pour un usage
      // futur éventuel de ClientEvents custom.
      void capturedRtSession;

      // Mark the moment the session is ready — anything after this until the
      // first 'speaking' transition is the greeting latency.
      sessionReadyAtMs = Date.now();
      tSessionStarted = sessionReadyAtMs;
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
      // Coût USD de l'appel à partir du breakdown tokens (cf. src/pricing).
      const totalTokens = inputTokensTotal + outputTokensTotal;
      const costUsd = computeRealtimeCostUsd(
        {
          inAudio: inAudioTokens,
          inText: inTextTokens,
          inCachedAudio: inCachedAudioTokens,
          inCachedText: inCachedTextTokens,
          outAudio: outAudioTokens,
          outText: outTextTokens,
        },
        cfg.model,
      );
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
        `Tokens: ${totalTokens.toLocaleString('en-US')} (~$${costUsd.toFixed(4)}) · ` +
        `Trans: ${fmtMs(transMean)} · EOU: ${fmtMs(eouMean)} · ` +
        `FirstAudio: ${fmtMs(serverFirstAudio.mean)}`;

      await remoteLog('latency', 'call_metrics', summary, 'info', {
        // Headline KPIs (the user-perceived numbers)
        ttfaMs: ttfa,
        responseDurationMs: dur,
        greetingMs,
        greetingSource,
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
        // Consommation + coût de l'appel (affiché dans /dashboard/logs).
        // Coût figé au tarif du moment de l'appel → historiquement exact.
        usage: {
          model: cfg.model,
          inputTokens: inputTokensTotal,
          outputTokens: outputTokensTotal,
          totalTokens,
          cachedInputTokens,
          costUsd,
        },
        // Routing context for filtering in /dashboard/logs
        fromNumber,
        toNumber,
        // Origin — REQUIS pour que lib/logger.ts web résolve user_id pour les
        // appels web (qui n'ont ni fromNumber ni toNumber). Sans ça, web
        // call_metrics arrivent avec events.user_id=NULL → invisibles dans
        // le graph Monitoring qui filtre par user_id.
        origin,
        // Setup phase breakdown : où le temps part avant le greeting.
        setupMs: {
          connect: setupConnect,
          sipWait: setupSip,
          configFetch: setupConfig,
          sessionStart: setupSession,
          total: setupTotal,
        },
        // Raw arrays for power-user debug + drill-down chart dans /dashboard.
        // Chaque array contient 1 valeur par tour de conversation, ordre
        // chronologique. Permet d'afficher des time-series par-turn.
        rawTtftMs: ttftMsList,
        rawServerEouMs: serverEouDelayMs,
        rawServerTransMs: serverTranscriptionDelayMs,
        rawServerFirstAudioMs: serverFirstAudioDelayMs,
        // Topologie infra — où chaque composant tourne. Snapshot des env
        // INFRA_* lues au moment de l'appel. Permet d'expliquer une
        // latence (e.g. worker EU ↔ OpenAI US = ~120ms RTT incompressible).
        topology: {
          twilio: process.env['INFRA_TWILIO_EDGE'] ?? 'unknown',
          worker: process.env['INFRA_WORKER_REGION'] ?? 'unknown',
          web: process.env['INFRA_WEB_REGION'] ?? 'unknown',
          livekit: process.env['INFRA_LIVEKIT_REGION'] ?? 'unknown',
          openai: process.env['INFRA_OPENAI_REGION'] ?? 'unknown',
          // Canal d'arrivée de l'appel (PSTN vs WhatsApp) — undefined pour
          // les origines non-sip (web / unknown). Permet au monitoring de
          // drill-down par channel.
          channel: origin.kind === 'sip' ? origin.channel : undefined,
        },
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
