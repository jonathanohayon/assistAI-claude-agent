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
import * as google from '@livekit/agents-plugin-google';
import * as openai from '@livekit/agents-plugin-openai';
import * as xai from '@livekit/agents-plugin-xai';
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
import { z } from 'zod';

import {
  REALTIME_CONFIG,
  resolveAgentName,
} from './config.js';
import {
  callAgentWebhook,
  stallLine,
  type WebhookTurn,
} from './src/agent-webhook.js';
import { getTtsEngine } from './src/tts/index.js';
import { closeWithTimeout, createZombieWatch } from './src/realtime-shutdown.js';
import type { ClosableSession } from './src/realtime-shutdown.js';
import {
  geminiLiveOptions,
  grokOptions,
  providerLanguageWarning,
  resolveRealtimeProvider,
  withKeyFallback,
} from './src/realtime-provider.js';
import type { RealtimeProvider } from './src/realtime-provider.js';
import { reportUsage } from './src/usage-report.js';
import { classifyRealtimeError, createFatalGate, geminiErrorCode } from './src/realtime-errors.js';
import { reportTurn } from './src/vox-config.js';
import { fetchConfig } from './src/config-fetcher.js';
import { ConfigRefusedError } from './src/config-refusal.js';
import { deleteRoom } from './src/hangup.js';
import {
  END_CALL_HARD_CAP_MS,
  END_CALL_TRAILING_MS,
  SILENCE_GRACE_START_MS,
} from './src/constants.js';
import { describeOpenAiKey, resolveOpenAiKey } from './src/openai-key.js';
import { fetchOpenerPcm, pcmToFrameStream } from './src/greeting-player.js';
import { sniffLang } from './src/lang-sniff.js';
import { detectOrigin, sipFromOf, sipToOf } from './src/origin.js';
import { startHeartbeat } from './src/heartbeat.js';
import { buildPerCallContext, buildSessionInstructions } from './src/per-call-context.js';
import { clientProfileLine } from './src/client-profile.js';
import { findSipCallerIdentity, transferCall, transferEligible } from './src/transfer.js';
import {
  DEFAULT_VOICE_PROFILE,
  mapGemini,
  mapGrok,
  mapOpenAI,
  mapSession,
  profileInstructions,
  resolveVoiceProfile,
} from './src/voice-profile.js';
import { toIsraeliLocal } from './src/phone.js';
import { postCallEnd, postCampaignResult } from './src/post-call.js';
import { createCampaignProgressReporter } from './src/campaign-progress.js';
import { computeCallCostUsd } from './src/pricing.js';
import { probeRegionsAtStartup } from './src/region-probe.js';
import { enterSession, remoteLog } from './src/remote-log.js';
import { callIdFromRoomName, currentCallId } from './src/session-context.js';
import { extractText } from './src/transcript.js';
import type {
  ProcessUserData,
  TranscriptEntry,
} from './src/types.js';
import { makeBusinessTools } from './tools/business.js';
import { makeCalendarTools } from './tools/calendar.js';
import { makeClientAgentTools } from './tools/client-agent.js';
import { isVoxToolCall } from './src/client-agent.js';
import { makeKnowledgeTools } from './tools/knowledge.js';
import { makeOrdersTools } from './tools/orders.js';

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
    console.log(describeOpenAiKey(resolveOpenAiKey()));

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
    const apiKey = resolveOpenAiKey().key;

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
    // callId = hash of the LiveKit room name (unique per call; the raw name
    // embeds the caller's number): stamped on every web request and event
    // of this call (src/session-context.ts).
    enterSession({ origin, ...(ctx.room.name ? { callId: callIdFromRoomName(ctx.room.name) } : {}) });

    // Outbound campaign: report live call progress (ringing / answered /
    // ended) to the admin console from the callee's `sip.callStatus`.
    const campaignProgress =
      origin.kind === 'campaign'
        ? createCampaignProgressReporter({
            campaignId: origin.campaignId,
            contactId: origin.contactId,
          })
        : null;
    if (campaignProgress) {
      const isCallee = (p: { identity: string; attributes: Record<string, string> }) =>
        p.identity.startsWith('callee-') || 'sip.callStatus' in p.attributes;
      const feed = (p: { identity: string; attributes: Record<string, string> }) => {
        if (isCallee(p)) campaignProgress.onSipStatus(p.attributes['sip.callStatus']);
      };
      for (const [, p] of ctx.room.remoteParticipants) feed(p);
      ctx.room.on(RoomEvent.ParticipantConnected, feed);
      ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => feed(p));
      ctx.room.on(RoomEvent.ParticipantDisconnected, (p) => {
        if (isCallee(p)) campaignProgress.ended();
      });
    }
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

    let cfg: Awaited<ReturnType<typeof fetchConfig>>;
    try {
      // Caller (From) for the loyalty profile: SIP attrs are there once
      // detectOrigin resolved; withheld number → no profile.
      let caller = '';
      for (const [, p] of ctx.room.remoteParticipants) caller ||= sipFromOf(p);
      cfg = await fetchConfig(origin, { caller });
    } catch (e) {
      if (!(e instanceof ConfigRefusedError)) throw e;
      // The web refused this call (unknown number, trial over). Never answer
      // with the default persona: one error event, then drop the line.
      await remoteLog(
        'agent',
        'call_refused',
        `Appel refusé (${e.reason}) — ${originLabel}`,
        'error',
        { reason: e.reason, origin },
      );
      await deleteRoom(ctx.room.name ?? '');
      return;
    }

    // ── Mode BYO-agent ──────────────────────────────────────────────────
    // Quand le tenant a branché son propre agent, le modèle Realtime cesse
    // d'être le cerveau : il transcrit et il parle, et chaque tour part vers
    // le endpoint du client. Absent → comportement historique intact.
    const agentWebhook = cfg.agentWebhook;
    // tamaravox tool mode (src/client-agent.ts): Tamara stays the brain and
    // the client's agent is the ask_client_agent tool. Only for tamaravox
    // configs; then the legacy verbatim mode below is OFF for this call.
    const voxToolMode = isVoxToolCall(cfg);
    const webhookMode = Boolean(agentWebhook?.url) && !voxToolMode;
    if (voxToolMode) {
      console.log(`[client_agent] tool mode → ${agentWebhook!.url}`);
    }
    if (webhookMode) {
      console.log(`[webhook_agent] mode actif → ${agentWebhook!.url}`);
    }
    tConfigFetched = Date.now();
    // fire-and-forget : ne jamais bloquer le chemin d'appel sur la télémétrie
    void remoteLog(
      'agent',
      'config_loaded',
      `Config chargée : ${cfg.model} / ${cfg.voice}`,
      'info',
      { model: cfg.model, voice: cfg.voice },
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
    // Captured ref to the active RealtimeSession, for custom ClientEvents.
    // Set by the LoggingRealtimeModel.session() override.
    let capturedRtSession: ClosableSession | null = null;
    // Flags a Realtime WebSocket that outlives the job (src/realtime-shutdown).
    const zombieWatch = createZombieWatch();
    ctx.addShutdownCallback(async () => {
      const { lastEventAgoMs } = zombieWatch.markShutdown();
      const result = await closeWithTimeout(capturedRtSession, 3_000);
      void remoteLog(
        'agent',
        'realtime_session_shutdown',
        `Realtime session at job shutdown: ${result} (last server event ${lastEventAgoMs ?? '?'} ms before)`,
        result === 'timeout' || result === 'error' ? 'warn' : 'info',
        { result, lastEventAgoMs },
      );
    });
    // Fires once per call on a non-retryable OpenAI error (src/realtime-errors).
    const fatalGate = createFatalGate();

    class LoggingRealtimeModel extends openai.realtime.RealtimeModel {
      override session(): openai.realtime.RealtimeSession {
        const sess = super.session();
        capturedRtSession = sess;
        sess.on('openai_server_event_received', (event: unknown) => {
          if (zombieWatch.onEvent()) {
            // The job is over but OpenAI is still talking to us: a surviving
            // WebSocket. Reported once; close it again.
            void remoteLog(
              'agent',
              'realtime_zombie_detected',
              'OpenAI Realtime event received after job shutdown — closing the session again',
              'error',
              { eventType: (event as { type?: string })?.type ?? null },
            );
            void closeWithTimeout(sess, 3_000);
          }
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
              const kind = classifyRealtimeError(errCode);
              if (kind === 'fatal') {
                // Non-retryable (bad key, no quota…): report once, end the
                // call. Repeats until teardown are dropped on purpose.
                if (fatalGate(errCode)) {
                  console.error('[realtime_fatal_error]', errCode, errMsg);
                  void remoteLog(
                    'agent',
                    'realtime_fatal_error',
                    `OpenAI Realtime fatal (${errCode}) — call ended: ${errMsg.slice(0, 200)}`,
                    'error',
                    { code: errCode, rawEvent: event },
                  );
                  void closeSession(`openai_fatal:${errCode}`);
                }
                break;
              }
              // Benign: cancel/response races between the SDK and OpenAI,
              // no runtime impact. Kept visible as warn, not error.
              if (kind === 'benign') {
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

    // Engine: the tenant's admin-only setting (cfg.realtimeProvider), with
    // REALTIME_PROVIDER as a worker-staging override. BYO external-brain mode
    // stays on OpenAI (it relies on create_response). A provider without its
    // API key falls back to OpenAI, loudly, rather than a silent call.
    const requestedProvider: RealtimeProvider = webhookMode
      ? 'openai'
      : resolveRealtimeProvider(cfg.realtimeProvider);
    const { provider: realtimeProvider, missingKey } = withKeyFallback(requestedProvider);
    if (missingKey) {
      console.error(`[provider_key_missing] ${requestedProvider} requested but ${missingKey} is not set: falling back to OpenAI`);
      void remoteLog(
        'agent',
        'provider_key_missing',
        `${requestedProvider} requested but ${missingKey} is not set — call runs on OpenAI`,
        'error',
        { requested: requestedProvider, missingKey },
      );
    }
    const languageWarning = providerLanguageWarning(realtimeProvider, cfg.primaryLanguage);
    if (languageWarning) {
      void remoteLog('agent', 'provider_language_warning', languageWarning, 'warn', {
        provider: realtimeProvider,
        language: cfg.primaryLanguage,
      });
    }

    const grokMapped = mapGrok(resolveVoiceProfile(cfg.voiceProfile), {
      model: cfg.model,
      speed: cfg.speed,
      primaryLanguage: cfg.primaryLanguage,
      webhookMode,
    });
    // Grok Voice (xAI): OpenAI-compatible Realtime. Session captured for the
    // shutdown close (#14); its error events go through the same fatal gate.
    class LoggingGrokModel extends xai.realtime.RealtimeModel {
      override session(): ReturnType<xai.realtime.RealtimeModel['session']> {
        const sess = super.session();
        capturedRtSession = sess;
        // xAI reasoning.effort (session.update; default "high"). plugin-xai
        // 1.9.5 doesn't send it, so we do, only when the profile says "none".
        if (grokMapped.reasoningEffort) {
          sess.sendEvent({ type: 'session.update', session: { reasoning: { effort: grokMapped.reasoningEffort } } } as never);
        }
        sess.on('error', (ev: { error?: { code?: string; message?: string; body?: { code?: string } } }) => {
          const errCode = ev?.error?.code ?? ev?.error?.body?.code ?? '';
          const errMsg = ev?.error?.message ?? 'unknown error';
          if (errCode && fatalGate(errCode)) {
            console.error('[realtime_fatal_error]', errCode, errMsg);
            void remoteLog(
              'agent',
              'realtime_fatal_error',
              `Grok Voice fatal (${errCode}) — call ended: ${errMsg.slice(0, 200)}`,
              'error',
              { code: errCode, provider: 'xai' },
            );
            void closeSession(`xai_fatal:${errCode}`);
          }
        });
        return sess;
      }
    }

    // Gemini Live: same capture of the session for the shutdown close (#14).
    // The OpenAI-only raw-event latency breakdown and the fatal-error gate
    // (#11) do not apply to it; TTFA and tokens still come from MetricsCollected.
    class LoggingGeminiModel extends google.realtime.RealtimeModel {
      override session(): ReturnType<google.realtime.RealtimeModel["session"]> {
        const sess = super.session();
        capturedRtSession = sess;
        // Same fatal gate as OpenAI (#11): bad key / no billing / unknown
        // model ends the call once, loudly, instead of a silent line.
        sess.on('error', (ev: { error?: unknown }) => {
          const errCode = geminiErrorCode(ev?.error);
          const errMsg = (ev?.error as { message?: string } | undefined)?.message ?? 'unknown error';
          if (errCode && fatalGate(errCode)) {
            console.error('[realtime_fatal_error]', errCode, errMsg);
            void remoteLog(
              'agent',
              'realtime_fatal_error',
              `Gemini Live fatal (${errCode}) — call ended: ${errMsg.slice(0, 200)}`,
              'error',
              { code: errCode, provider: 'gemini' },
            );
            void closeSession(`gemini_fatal:${errCode}`);
          }
        });
        return sess;
      }
    }

    // Voice profile (admin-only): per-engine options. The default profile maps
    // to exactly the options used before (tests/voice-profile.test.ts).
    const profile = resolveVoiceProfile(cfg.voiceProfile);
    const mapCtx = {
      model: cfg.model,
      speed: cfg.speed,
      primaryLanguage: cfg.primaryLanguage,
      webhookMode,
    };
    const oaMapped = mapOpenAI(profile, mapCtx);
    const geminiMapped = mapGemini(profile, mapCtx);
    const sessionMapped = mapSession(profile);
    const reasoning = oaMapped.reasoning;
    // The engine that actually takes this call, with its real model id: on
    // every per-call event (Monitoring card, Finance, calls row).
    const engine = {
      provider: realtimeProvider,
      model:
        realtimeProvider === 'gemini'
          ? geminiLiveOptions(cfg).model
          : realtimeProvider === 'xai'
            ? grokOptions(cfg).model
            : cfg.model,
    };
    const rtModel = realtimeProvider === 'gemini'
      ? new LoggingGeminiModel({
          ...geminiLiveOptions(cfg),
          language: geminiMapped.language,
          realtimeInputConfig: {
            automaticActivityDetection: geminiMapped.automaticActivityDetection,
            ...(geminiMapped.activityHandling ? { activityHandling: geminiMapped.activityHandling } : {}),
          },
          ...(profile.voiceOverrides.gemini ? { voice: profile.voiceOverrides.gemini } : {}),
        })
      : realtimeProvider === 'xai'
        ? new LoggingGrokModel({
            ...grokOptions(cfg),
            ...(grokMapped.turnDetection ? { turnDetection: grokMapped.turnDetection as never } : {}),
            ...(profile.voiceOverrides.xai ? { voice: profile.voiceOverrides.xai } : {}),
          })
        : new LoggingRealtimeModel({
      apiKey,
      baseURL: REALTIME_CONFIG.apiBase,
      model: cfg.model,
      modalities: [...REALTIME_CONFIG.modalities],
      voice: profile.voiceOverrides.openai ?? cfg.voice,
      // No temperature: OpenAI Realtime GA rejects it (constructor and
      // session.update alike: `Unknown parameter: 'session.temperature'`).
      speed: oaMapped.speed,
      ...(oaMapped.noiseReduction ? { inputAudioNoiseReduction: oaMapped.noiseReduction } : {}),
      // Lowest reasoning for latency, only on the admin-only gpt-realtime-2.1.
      ...(reasoning ? { reasoning } : {}),
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
        language: oaMapped.transcriptionLanguage as 'he' | 'fr' | 'en',
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
      // Turn detection from the voice profile (default = server_vad 0.75 / 150 / 350 ms).
      turnDetection: oaMapped.turnDetection as never,
    });

    void remoteLog(
      'agent',
      'realtime_provider',
      `Realtime provider: ${realtimeProvider} · reasoning ${realtimeProvider === 'openai' ? (reasoning?.effort ?? 'none') : 'n/a'}`,
      'info',
      {
        provider: realtimeProvider,
        model: engine.model,
        engine,
        ...(missingKey ? { fallbackFrom: requestedProvider } : {}),
        // The effort actually sent to OpenAI ('none' = no reasoning param).
        reasoning: realtimeProvider === 'openai' ? (reasoning?.effort ?? 'none') : 'n/a',
        // Voice-profile settings that differ from the default (names + values),
        // so a call proves which profile it ran with.
        voiceProfile: Object.fromEntries(
          Object.entries(profile).filter(
            ([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULT_VOICE_PROFILE[k as keyof typeof DEFAULT_VOICE_PROFILE]),
          ),
        ),
      },
    );

    const session = new voice.AgentSession({
      // Pas de VAD local (Silero retiré car saturait le CPU du worker).
      // OpenAI server_vad gère la détection de tour côté serveur.
      llm: rtModel,
      // Interruption settings from the voice profile; SDK defaults otherwise.
      ...(sessionMapped.interruption ? { turnHandling: { interruption: sessionMapped.interruption } } : {}),
    });

    // ── Transcript capture ──────────────────────────────────────────────
    const transcript: TranscriptEntry[] = [];
    // État du mode BYO-agent : un tour à la fois, numérotés pour les logs.
    let webhookTurnInFlight = false;
    let webhookTurnId = 0;

    /**
     * Prononce un texte **mot pour mot**.
     *
     * En BYO, les mots appartiennent au client : les faire passer par le
     * modèle (« dis exactement ceci ») le laisse libre de reformuler, et les
     * reformulations tombent là où c'est inacceptable — prix, numéros,
     * mentions légales. Un TTS n'a pas cette latitude.
     *
     * Repli sur le modèle si aucun moteur n'est configuré : un agent qui
     * paraphrase reste préférable à un agent muet.
     */
    const speakVerbatim = async (text: string): Promise<void> => {
      const tts = getTtsEngine();
      if (tts) {
        try {
          const audio = await tts.speak(text, {
            voice: cfg.voice,
            language: cfg.primaryLanguage ?? 'fr',
            ...(cfg.speed ? { speed: cfg.speed } : {}),
          });
          // addToChatCtx : le modèle doit savoir ce qui a été dit en son nom,
          // sinon il repart de zéro au tour suivant.
          const handle = session.say(text, { audio, addToChatCtx: true });
          await Promise.race([
            handle.waitForPlayout(),
            new Promise((r) => setTimeout(r, 30_000)),
          ]);
          return;
        } catch (err) {
          console.warn(`[tts] ${(err as Error).message} — repli sur le modèle`);
        }
      }
      await session.generateReply({
        instructions: `Dis EXACTEMENT ceci, mot pour mot, sans rien ajouter ni reformuler :\n\n${text}`,
      });
    };
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

      // ── BYO-agent : le tour part chez le client ───────────────────────
      // Volontairement pas un tool Realtime : le SDK laisse tomber un tool
      // call quand le modèle y mêle de l'audio de remplissage. On appelle
      // hors du flux vocal, puis on fait prononcer la réponse.
      if (!webhookMode || !agentWebhook) return;
      if (webhookTurnInFlight) {
        // L'appelant a enchaîné avant qu'on ait répondu. On ignore le tour
        // précédent plutôt que d'empiler deux réponses qui se parleraient
        // dessus.
        console.warn('[webhook_agent] tour ignoré : requête déjà en vol');
        return;
      }
      webhookTurnInFlight = true;
      webhookTurnId += 1;
      const turnId = webhookTurnId;

      void (async () => {
        // Filet anti-silence : si le client dépasse ~700 ms, on meuble. Un
        // blanc au téléphone est indistinguable d'une ligne coupée.
        const stallTimer = setTimeout(() => {
          // La phrase d'attente ne doit jamais bloquer : on ne l'attend pas.
          void speakVerbatim(stallLine(cfg.primaryLanguage ?? 'fr')).catch(
            () => {
              /* jamais bloquant */
            },
          );
        }, 700);

        try {
          const history: WebhookTurn[] = transcript.map((entry) => ({
            role: entry.role === 'assistant' ? 'agent' : 'user',
            text: entry.text,
          }));

          const result = await callAgentWebhook(agentWebhook, {
            callId: ctx.room.name ?? 'call',
            turnId,
            language: cfg.primaryLanguage ?? 'fr',
            transcript: text,
            history,
          });
          clearTimeout(stallTimer);

          console.log(
            `[webhook_agent] turn ${turnId} → ${result.reply ? 'ok' : result.failure} in ${result.elapsedMs}ms`,
          );

          reportTurn({
            agentId: cfg.voxAgentId ?? '',
            callId: ctx.room.name ?? 'call',
            turnId,
            elapsedMs: result.elapsedMs,
            ok: Boolean(result.reply),
            ...(result.failure ? { failure: result.failure } : {}),
            ...(result.status ? { status: result.status } : {}),
            language: cfg.primaryLanguage ?? 'fr',
            transcript: text,
            ...(result.reply ? { reply: result.reply } : {}),
          });

          if (result.reply) {
            await speakVerbatim(result.reply);
            return;
          }

          void remoteLog(
            'agent',
            'webhook_agent_turn_failed',
            `Agent client injoignable ou hors contrat (${result.failure}, ${result.elapsedMs}ms)`,
            'warn',
            { turnId, failure: result.failure, status: result.status },
          );
          await speakVerbatim(stallLine(cfg.primaryLanguage ?? 'fr'));
        } catch (err) {
          clearTimeout(stallTimer);
          console.warn(
            `[webhook_agent] tour ${turnId} en erreur : ${(err as Error).message}`,
          );
        } finally {
          webhookTurnInFlight = false;
        }
      })();
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
        campaignProgress?.ended();
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
        (Date.now() - sessionStartedAt) / 1000,
        engine,
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
      await deleteRoom(ctx.room.name ?? '');
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
    let greetingSource: 'prerendered' | 'model' | 'webhook' = 'model';
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

    // Gemini watchdog: a generation that never produces audio leaves the
    // caller in silence (seen on staging after an interrupted greeting). If
    // the agent stays "thinking" for 4 s without speaking, interrupt it and
    // ask for the reply again, at most twice per call.
    if (realtimeProvider === 'gemini') {
      const SILENT_GEN_MS = 4_000;
      const MAX_SILENT_RETRIES = 2;
      let silentRetries = 0;
      let silentTimer: ReturnType<typeof setTimeout> | null = null;
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
        const next = (ev as { newState?: string }).newState;
        if (silentTimer) {
          clearTimeout(silentTimer);
          silentTimer = null;
        }
        if (next !== 'thinking' || silentRetries >= MAX_SILENT_RETRIES) return;
        silentTimer = setTimeout(() => {
          silentTimer = null;
          silentRetries += 1;
          console.warn(`[gemini_silent_gen] no audio after ${SILENT_GEN_MS} ms, retry ${silentRetries}/${MAX_SILENT_RETRIES}`);
          void remoteLog(
            'agent',
            'gemini_silent_gen',
            `Gemini generation produced no audio in ${SILENT_GEN_MS} ms — reply re-issued (${silentRetries}/${MAX_SILENT_RETRIES})`,
            'warn',
            { retry: silentRetries },
          );
          void (async () => {
            try {
              await session.interrupt();
            } catch {
              /* nothing to interrupt */
            }
            session.generateReply();
          })();
        }, SILENT_GEN_MS);
      });
      // A tool round-trip also shows as "thinking": restart the clock when
      // tools finish so a slow calendar call isn't taken for silence.
      session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, () => {
        if (silentTimer) {
          clearTimeout(silentTimer);
          silentTimer = null;
        }
      });
    }

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
      if (Date.now() - sessionStartedAt > sessionMapped.maxDurationMs) {
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
      if (Date.now() - lastActivity > sessionMapped.idleHangupMs) {
        clearInterval(silenceWatcher);
        void closeSession(`silence_${sessionMapped.idleHangupMs}ms`);
      }
    }, 2_000);

    // ── end_call tool — exposed to the LLM ──────────────────────────────
    // ── Call transfer (PSTN only) ──────────────────────────────────────
    // Tool first, announcement after: the Realtime SDK drops a tool call
    // that comes in the same response as filler speech, so the model calls
    // transfer_call, then announces; the REFER starts once that announcement
    // has played (8 s cap). No number or a failed REFER -> the model apologises
    // and offers to take a message.
    const isPstnCall = origin.kind === 'sip' && origin.channel === 'pstn';
    const canTransfer = transferEligible({
      originKind: origin.kind,
      channel: origin.kind === 'sip' ? origin.channel : undefined,
      transferNumber: cfg.transferNumber,
    });
    let transferState: { attempted: boolean; ok?: boolean; error?: string; reason?: string } = {
      attempted: false,
    };
    const waitForAnnouncement = (capMs: number) =>
      new Promise<void>((resolve) => {
        let spoke = false;
        const done = () => {
          clearTimeout(cap);
          session.off(voice.AgentSessionEventTypes.AgentStateChanged, onState);
          resolve();
        };
        const onState = (ev: { newState?: string }) => {
          if (ev.newState === 'speaking') spoke = true;
          else if (spoke) done();
        };
        const cap = setTimeout(done, capMs);
        session.on(voice.AgentSessionEventTypes.AgentStateChanged, onState);
      });
    const transferCallTool = llm.tool({
      description:
        "Transfers the caller to a person at the business (the owner or the team). Use it ONLY when the caller explicitly asks to speak to a person, or when you really can't help. Call this tool FIRST, without saying anything before it; its result tells you what to say next. Never call end_call after a transfer.",
      parameters: z.object({
        reason: z
          .string()
          .nullish()
          .describe("Short reason: 'caller_asked_for_person', 'cannot_help', 'complaint', 'urgent'."),
      }),
      execute: async ({ reason }) => {
        const why = (reason ?? 'caller_asked_for_person').trim() || 'caller_asked_for_person';
        if (transferState.attempted) return 'A transfer is already in progress. Say nothing more.';
        if (!canTransfer) {
          transferState = { attempted: true, ok: false, error: 'no_transfer_number', reason: why };
          void remoteLog('agent', 'call_transfer', 'Transfer requested but no transfer number is set', 'info', {
            ok: false,
            error: 'no_transfer_number',
            reason: why,
          });
          return "No one can take the call right now. Tell the caller, in one short sentence in their language, that the team isn't available by phone at the moment, and offer to take a message (name, number, reason).";
        }
        const identity = findSipCallerIdentity(ctx.room.remoteParticipants.values());
        transferState = { attempted: true, reason: why };
        void (async () => {
          await waitForAnnouncement(8_000);
          const r = identity
            ? await transferCall({
                roomName: ctx.room.name ?? '',
                participantIdentity: identity,
                transferNumber: cfg.transferNumber ?? '',
              })
            : ({ ok: false, error: 'no_sip_participant' } as const);
          transferState = r.ok
            ? { attempted: true, ok: true, reason: why }
            : { attempted: true, ok: false, error: r.error, reason: why };
          void remoteLog(
            'agent',
            'call_transfer',
            r.ok ? 'Call transferred to the business' : `Call transfer failed: ${r.error}`,
            r.ok ? 'info' : 'warn',
            { ok: r.ok, reason: why, ...(r.ok ? {} : { error: r.error }) },
          );
          if (!r.ok) {
            try {
              await session.generateReply({
                instructions:
                  "The transfer didn't go through. Apologise in one short sentence in the caller's language, say the person isn't available right now, and offer to take a message (name, number, reason).",
              });
            } catch {
              /* best-effort */
            }
          }
        })();
        return 'Transfer scheduled. Now tell the caller, in ONE short sentence in their language, that you are transferring them to someone from the team. Say nothing else after that.';
      },
    });

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
        // Gemini POC: the pre-rendered opener is OpenAI TTS in the tenant's
        // OpenAI voice; playing it would give the call two different voices.
        // Let Gemini speak the greeting itself.
        const opener = realtimeProvider === 'gemini' ? null : await openerPromise;
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

        // ── BYO-agent : c'est l'agent du client qui ouvre ─────────────────
        // Laisser le modèle improviser l'accueil avec la persona du tenant
        // dirait au client des choses que son agent n'a jamais écrites. On
        // demande le tour 0 au endpoint, et on ne retombe sur le modèle que
        // s'il ne répond pas.
        if (webhookMode && agentWebhook) {
          const opening = await callAgentWebhook(agentWebhook, {
            callId: ctx.room.name ?? 'call',
            turnId: 0,
            language: cfg.primaryLanguage ?? 'fr',
            transcript: '',
            history: [],
          });
          console.log(
            `[webhook_agent] accueil → ${opening.reply ? 'ok' : opening.failure} in ${opening.elapsedMs}ms`,
          );
          if (opening.reply) {
            await speakVerbatim(opening.reply);
            greetingSource = 'webhook';
            return;
          }
        }

        // ── Fallback : accueil par le modèle (comportement historique) ─────
        // PER_CALL_CONTEXT is at the end of the session instructions, so it is
        // sent during session.start(). Si greetInstructions est vide,
        // generateReply sans override → le LLM ouvre selon son persona.
        // Gemini: no pre-rendered opener, so the model speaks the greeting.
        // NOT muted: on staging, muting the input during a Gemini greeting
        // made the plugin drop the greeting audio ("received server content
        // but no active generation"). An interrupted greeting is instead
        // recovered by the silent-generation watchdog below.
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

    // Tool de prise de commandes — enregistré UNIQUEMENT si le tenant a activé
    // le toggle "Commandes" (cfg.ordersEnabled). Sinon le modèle ne voit pas
    // le tool et ne peut pas l'halluciner (cf. même logique que calendar/crm).
    const ordersTools = cfg.ordersEnabled
      ? makeOrdersTools({
          dialedPhone: toNumber,
          getDialedPhone: () => toNumber,
          tenantUserId,
          getCallerPhone: () => toIsraeliLocal(fromNumber),
        })
      : {};

    // Numéro de l'appelant en format local israélien (+972… → 0…) — les
    // clientes dictent/écoutent en local, les tools stockent en local.
    const localFromNumber = toIsraeliLocal(fromNumber);

    // Contexte per-call (date/heure Jérusalem + caller-hint substitués dans
    // le template per-plan ou le fallback) — assemblé par
    // src/per-call-context.ts, extrait verbatim de l'inline historique.
    const { perCallContext: basePerCallContext, callerHintBlock } =
      buildPerCallContext(localFromNumber, cfg.perCallContextTemplate);
    // Loyalty v1: one line on a known caller ('' otherwise → unchanged).
    const loyaltyLine = clientProfileLine(cfg.clientProfile ?? null);
    const PER_CALL_CONTEXT = loyaltyLine
      ? `${basePerCallContext}\n\n${loyaltyLine}`
      : basePerCallContext;

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
    // tamaravox tool mode only: aitamara calls get no extra tool.
    const clientAgentTools =
      voxToolMode && agentWebhook
        ? makeClientAgentTools({
            webhook: agentWebhook,
            getCallId: () => currentCallId() ?? 'call',
            getLanguage: () => {
              const lastUser = [...transcript].reverse().find((t) => t.role === 'user');
              return lastUser && sniffLang(lastUser.text) === 'he' ? 'he' : (cfg.primaryLanguage ?? 'en');
            },
            getCallerSaid: () => [...transcript].reverse().find((t) => t.role === 'user')?.text ?? '',
            getHistory: () =>
              transcript.map((t) => ({ role: t.role === 'assistant' ? ('agent' as const) : ('user' as const), text: t.text })),
            startStall: () => {
              // Holding line only with a TTS engine: session.say needs real
              // audio on a Realtime session, and generateReply mid-tool would
              // start a competing response.
              const tts = getTtsEngine();
              if (!tts) {
                console.log('[client_agent] holding line skipped: no TTS engine');
                return null;
              }
              let cancelled = false;
              let handle: { interrupt: () => void } | null = null;
              const line = stallLine(cfg.primaryLanguage ?? 'en');
              void tts
                .speak(line, { voice: cfg.voice, language: cfg.primaryLanguage ?? 'en', ...(cfg.speed ? { speed: cfg.speed } : {}) })
                .then((audio) => {
                  if (cancelled) return;
                  handle = session.say(line, { audio, addToChatCtx: false });
                })
                .catch((e) => console.warn(`[client_agent] holding line failed: ${(e as Error).message}`));
              return () => {
                cancelled = true;
                try {
                  handle?.interrupt();
                } catch {
                  /* already played */
                }
              };
            },
            onResult: (r) =>
              reportTurn({
                agentId: cfg.voxAgentId ?? '',
                callId: currentCallId() ?? 'call',
                turnId: r.turnId,
                elapsedMs: r.elapsedMs,
                ok: Boolean(r.answer),
                ...(r.failure ? { failure: r.failure } : {}),
                ...(r.status ? { status: r.status } : {}),
                language: r.language,
                transcript: r.callerSaid || r.question,
                ...(r.answer ? { reply: r.answer } : {}),
              }),
          })
        : {};

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
          ...(cfg.ordersEnabled ? ['record_order'] : []),
          ...businessNames,
          ...knowledgeNames,
          ...Object.keys(clientAgentTools),
          'end_call',
        ],
      },
    );

    // Per-call context goes at the END of the instructions, not in the initial
    // chat context: on 1.9.5 each chat-context item costs a provider round
    // trip inside session.start() (~1 s before the greeting). The static part
    // stays an identical prefix for the prompt cache (src/per-call-context).
    const agent = new TenantAgent({
      instructions: buildSessionInstructions(
        [STATIC_INSTRUCTIONS, profileInstructions(profile, realtimeProvider, mapCtx)].filter(Boolean).join('\n\n'),
        PER_CALL_CONTEXT,
      ),
      chatCtx: llm.ChatContext.empty(),
      tools: {
        ...calendarTools,
        ...ordersTools,
        ...businessTools,
        ...knowledgeTools,
        end_call: endCallTool,
        ...(isPstnCall ? { transfer_call: transferCallTool } : {}),
        ...clientAgentTools,
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
      // Per engine: OpenAI/Gemini by tokens, Grok by connected minute.
      const { costUsd, pricing } = computeCallCostUsd({
        provider: engine.provider,
        model: engine.model,
        tokens: {
          inAudio: inAudioTokens,
          inText: inTextTokens,
          inCachedAudio: inCachedAudioTokens,
          inCachedText: inCachedTextTokens,
          outAudio: outAudioTokens,
          outText: outTextTokens,
        },
        sessionSeconds: (Date.now() - sessionStartedAt) / 1000,
      });
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
          provider: engine.provider,
          model: engine.model,
          inputTokens: inputTokensTotal,
          outputTokens: outputTokensTotal,
          // Absent (not 0) when the engine reports no tokens (Grok).
          ...(totalTokens > 0 ? { totalTokens } : {}),
          cachedInputTokens,
          costUsd,
          pricing,
        },
        engine,
        // Call transfer to the business (PSTN), if the agent attempted one.
        ...(transferState.attempted ? { transfer: transferState } : {}),
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
      // Real usage for the admin Finance box, every engine, with its own cost.
      await reportUsage({
        callId: ctx.room.name ?? 'call',
        provider: engine.provider,
        model: engine.model,
        inputTokensTotal,
        cachedInputTokens,
        outputTokens: outputTokensTotal,
        costUsd,
        durationSeconds: (Date.now() - sessionStartedAt) / 1000,
        userId: origin.kind === 'web' ? origin.userId : undefined,
        toNumber: toNumber || undefined,
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
          engine,
        },
      );
      await triggerRecap();
    }
  },
});

// Alive signal + hourly model-key checks to the web (founder alerts when it
// stops). Once, in the main worker process: job processes, which also import
// this module, are skipped (src/heartbeat isWorkerMainProcess).
startHeartbeat({
  agentName: resolveAgentName(),
  version: process.env['RAILWAY_GIT_COMMIT_SHA']?.slice(0, 7) ?? 'dev',
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: resolveAgentName(),
  }),
);
