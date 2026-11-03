/**
 * Voice profile -> per-engine options (phase 1 of Fable's plan).
 *
 * The web sends the tenant's full effective profile (defaults = today's exact
 * behaviour, web lib/voice-profile.ts). mapVoiceProfile is pure: with the
 * default profile it returns exactly the options the worker used before this
 * change, for every engine (snapshot tests in tests/voice-profile.test.ts).
 */
import { ActivityHandling, EndSensitivity, StartSensitivity } from '@google/genai';

import type { RealtimeProvider } from './realtime-provider.js';

export interface VoiceProfile {
  turnSensitivity: number; // 1..5, 3 = today
  bargeIn: boolean;
  keyTerms: string[];
  languageHint: 'auto' | 'fr' | 'he' | 'en';
  voiceOverrides: Partial<Record<RealtimeProvider, string>>;
  minInterruptionMs: number;
  idleHangupSec: number;
  maxDurationMin: number;
  pace: 'slow' | 'normal' | 'fast';
  pronunciations: Array<{ term: string; sayAs: string }>;
  fillers: boolean;
  speakingStyle: string;
  languageLock: boolean;
  openaiTurnMode: 'server_vad' | 'semantic_vad';
  openaiEagerness: 'auto' | 'low' | 'medium' | 'high';
  openaiNoiseReduction: 'off' | 'near_field' | 'far_field';
  openaiReasoning: 'default' | 'none' | 'low' | 'medium' | 'high';
  grokReasoning: 'high' | 'none';
}

/** Mirror of the web DEFAULT_VOICE_PROFILE (2026-11-03 behaviour). */
export const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  turnSensitivity: 3,
  bargeIn: true,
  keyTerms: [],
  languageHint: 'auto',
  voiceOverrides: {},
  minInterruptionMs: 500,
  idleHangupSec: 30,
  maxDurationMin: 30,
  pace: 'normal',
  pronunciations: [],
  fillers: true,
  speakingStyle: '',
  languageLock: false,
  openaiTurnMode: 'server_vad',
  openaiEagerness: 'auto',
  openaiNoiseReduction: 'off',
  openaiReasoning: 'default',
  grokReasoning: 'high',
};

/** Profile from /api/agent/config; anything missing or invalid -> default. */
export function resolveVoiceProfile(raw: unknown): VoiceProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_VOICE_PROFILE;
  const int = (v: unknown, min: number, max: number, def: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def;
  const pick = <T extends string>(v: unknown, opts: readonly T[], def: T): T =>
    typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T) : def;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, 50) : [];
  const overrides: Partial<Record<RealtimeProvider, string>> = {};
  const vo = (r['voiceOverrides'] ?? {}) as Record<string, unknown>;
  for (const p of ['openai', 'gemini', 'xai'] as const) {
    const v = vo[p];
    if (typeof v === 'string' && v.trim()) overrides[p] = v.trim();
  }
  return {
    turnSensitivity: int(r['turnSensitivity'], 1, 5, d.turnSensitivity),
    bargeIn: typeof r['bargeIn'] === 'boolean' ? r['bargeIn'] : d.bargeIn,
    keyTerms: strings(r['keyTerms']),
    languageHint: pick(r['languageHint'], ['auto', 'fr', 'he', 'en'] as const, d.languageHint),
    voiceOverrides: overrides,
    minInterruptionMs: int(r['minInterruptionMs'], 0, 2000, d.minInterruptionMs),
    idleHangupSec: int(r['idleHangupSec'], 10, 120, d.idleHangupSec),
    maxDurationMin: int(r['maxDurationMin'], 1, 60, d.maxDurationMin),
    pace: pick(r['pace'], ['slow', 'normal', 'fast'] as const, d.pace),
    pronunciations: Array.isArray(r['pronunciations'])
      ? (r['pronunciations'] as Array<Record<string, unknown>>)
          .filter((p) => typeof p?.['term'] === 'string' && typeof p?.['sayAs'] === 'string')
          .map((p) => ({ term: String(p['term']), sayAs: String(p['sayAs']) }))
          .slice(0, 50)
      : [],
    fillers: typeof r['fillers'] === 'boolean' ? r['fillers'] : d.fillers,
    speakingStyle: typeof r['speakingStyle'] === 'string' ? r['speakingStyle'].slice(0, 300) : '',
    languageLock: typeof r['languageLock'] === 'boolean' ? r['languageLock'] : d.languageLock,
    openaiTurnMode: pick(r['openaiTurnMode'], ['server_vad', 'semantic_vad'] as const, d.openaiTurnMode),
    openaiEagerness: pick(r['openaiEagerness'], ['auto', 'low', 'medium', 'high'] as const, d.openaiEagerness),
    openaiNoiseReduction: pick(r['openaiNoiseReduction'], ['off', 'near_field', 'far_field'] as const, d.openaiNoiseReduction),
    openaiReasoning: pick(r['openaiReasoning'], ['default', 'none', 'low', 'medium', 'high'] as const, d.openaiReasoning),
    grokReasoning: pick(r['grokReasoning'], ['high', 'none'] as const, d.grokReasoning),
  };
}

/**
 * Turn sensitivity 1..5 -> server VAD. 3 is today's tuning (threshold 0.75,
 * 350 ms of silence). Lower = waits longer before answering (fewer cut-offs);
 * higher = answers sooner after a pause.
 */
// Threshold and silence: patient (1) = higher threshold (less triggered by
// noise) and longer silence. Prefix padding per Fable's table.
const VAD_BY_LEVEL: Record<number, { threshold: number; silenceMs: number; prefixMs: number }> = {
  1: { threshold: 0.85, silenceMs: 800, prefixMs: 300 },
  2: { threshold: 0.8, silenceMs: 550, prefixMs: 200 },
  3: { threshold: 0.75, silenceMs: 350, prefixMs: 150 },
  4: { threshold: 0.7, silenceMs: 250, prefixMs: 120 },
  5: { threshold: 0.6, silenceMs: 180, prefixMs: 100 },
};

const PACE_FACTOR = { slow: 0.9, normal: 1, fast: 1.15 } as const;

export interface MapContext {
  /** OpenAI model of the tenant (cfg.model). */
  model: string;
  /** Tenant speed setting (cfg.speed), OpenAI only. */
  speed: number;
  primaryLanguage: string | null | undefined;
  /** BYO external brain: the model must not answer on its own. */
  webhookMode: boolean;
}

export interface OpenAIMapped {
  turnDetection: Record<string, unknown>;
  speed: number;
  noiseReduction?: { type: 'near_field' | 'far_field' };
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  transcriptionLanguage: string;
}

export function mapOpenAI(p: VoiceProfile, ctx: MapContext): OpenAIMapped {
  const level = VAD_BY_LEVEL[p.turnSensitivity] ?? VAD_BY_LEVEL[3]!;
  const turnDetection: Record<string, unknown> =
    p.openaiTurnMode === 'semantic_vad'
      ? { type: 'semantic_vad', eagerness: p.openaiEagerness, create_response: !ctx.webhookMode }
      : {
          type: 'server_vad',
          threshold: level.threshold,
          prefix_padding_ms: level.prefixMs,
          silence_duration_ms: level.silenceMs,
          create_response: !ctx.webhookMode,
        };
  // Only sent when barge-in is turned off: the default payload stays exactly
  // as before.
  if (!p.bargeIn) turnDetection['interrupt_response'] = false;
  const speed = clampSpeed(ctx.speed * PACE_FACTOR[p.pace]);
  const reasoning =
    p.openaiReasoning === 'default'
      ? ctx.model.startsWith('gpt-realtime-2.1')
        ? { effort: 'low' as const }
        : undefined
      : p.openaiReasoning === 'none'
        ? undefined
        : { effort: p.openaiReasoning };
  return {
    turnDetection,
    speed,
    ...(p.openaiNoiseReduction !== 'off' ? { noiseReduction: { type: p.openaiNoiseReduction } } : {}),
    ...(reasoning ? { reasoning } : {}),
    transcriptionLanguage: language(p, ctx),
  };
}

export interface GeminiMapped {
  automaticActivityDetection: {
    startOfSpeechSensitivity: StartSensitivity;
    endOfSpeechSensitivity: EndSensitivity;
    prefixPaddingMs: number;
    silenceDurationMs: number;
  };
  /** Only set when barge-in is off (default: Gemini's own, i.e. interrupts). */
  activityHandling?: ActivityHandling;
  language: string;
}

export function mapGemini(p: VoiceProfile, ctx: MapContext): GeminiMapped {
  const level = VAD_BY_LEVEL[p.turnSensitivity] ?? VAD_BY_LEVEL[3]!;
  return {
    automaticActivityDetection: {
      // Fable's table: start HIGH only at 5 (most eager); end HIGH from 3.
      startOfSpeechSensitivity:
        p.turnSensitivity >= 5 ? StartSensitivity.START_SENSITIVITY_HIGH : StartSensitivity.START_SENSITIVITY_LOW,
      endOfSpeechSensitivity:
        p.turnSensitivity >= 3 ? EndSensitivity.END_SENSITIVITY_HIGH : EndSensitivity.END_SENSITIVITY_LOW,
      prefixPaddingMs: level.prefixMs,
      silenceDurationMs: level.silenceMs,
    },
    ...(!p.bargeIn ? { activityHandling: ActivityHandling.NO_INTERRUPTION } : {}),
    // Gemini Live takes a BCP-47 code (as in geminiLiveOptions).
    language: BCP47[language(p, ctx)] ?? 'fr-FR',
  };
}

const BCP47: Record<string, string> = { he: 'he-IL', fr: 'fr-FR', en: 'en-US' };

export interface GrokMapped {
  /** undefined = keep the plugin's xAI-tuned default (today). */
  turnDetection?: Record<string, unknown>;
  /** undefined = xAI default ("high"), nothing sent (today). */
  reasoningEffort?: 'none';
}

export function mapGrok(p: VoiceProfile, ctx: MapContext): GrokMapped {
  const changed = p.turnSensitivity !== 3 || !p.bargeIn;
  const level = VAD_BY_LEVEL[p.turnSensitivity] ?? VAD_BY_LEVEL[3]!;
  return {
    ...(changed
      ? {
          turnDetection: {
            type: 'server_vad',
            threshold: level.threshold,
            prefix_padding_ms: level.prefixMs,
            silence_duration_ms: level.silenceMs,
            create_response: !ctx.webhookMode,
            ...(!p.bargeIn ? { interrupt_response: false } : {}),
          },
        }
      : {}),
    ...(p.grokReasoning === 'none' ? { reasoningEffort: 'none' as const } : {}),
  };
}

/** Session-level settings, same for every engine. */
export interface SessionMapped {
  /** undefined = the SDK defaults (today): interruptions on, 500 ms. */
  interruption?: { enabled: boolean; minDuration: number };
  idleHangupMs: number;
  maxDurationMs: number;
}

export function mapSession(p: VoiceProfile): SessionMapped {
  const isDefault = p.bargeIn && p.minInterruptionMs === DEFAULT_VOICE_PROFILE.minInterruptionMs;
  return {
    ...(isDefault ? {} : { interruption: { enabled: p.bargeIn, minDuration: p.minInterruptionMs } }),
    idleHangupMs: p.idleHangupSec * 1000,
    maxDurationMs: p.maxDurationMin * 60_000,
  };
}

/**
 * Instructions block from our layer (pace on non-OpenAI engines, fillers,
 * style, pronunciations, key terms, language lock). Empty for the default
 * profile, so the prompt is unchanged.
 */
export function profileInstructions(p: VoiceProfile, provider: RealtimeProvider, ctx: MapContext): string {
  const lines: string[] = [];
  if (provider !== 'openai' && p.pace !== 'normal') {
    lines.push(p.pace === 'slow' ? '- Speak slowly and clearly.' : '- Speak at a brisk, efficient pace.');
  }
  if (!p.fillers) lines.push('- Never use filler phrases ("let me check", "one moment"): answer directly.');
  if (p.speakingStyle.trim()) lines.push(`- Style: ${p.speakingStyle.trim()}`);
  if (p.languageLock) {
    lines.push(`- Always answer in ${LANG_NAME[language(p, ctx)] ?? language(p, ctx)}, even if the caller switches language.`);
  }
  if (p.keyTerms.length) lines.push(`- Key terms (recognise and spell exactly): ${p.keyTerms.join(', ')}`);
  if (p.pronunciations.length) {
    lines.push('- Pronunciation:');
    for (const x of p.pronunciations) lines.push(`  - "${x.term}" is pronounced "${x.sayAs}"`);
  }
  return lines.length ? `### Voice profile\n${lines.join('\n')}` : '';
}

const LANG_NAME: Record<string, string> = { fr: 'French', he: 'Hebrew', en: 'English' };

function language(p: VoiceProfile, ctx: MapContext): string {
  return p.languageHint !== 'auto' ? p.languageHint : ctx.primaryLanguage || 'fr';
}

function clampSpeed(s: number): number {
  return Math.min(1.5, Math.max(0.5, Math.round(s * 100) / 100));
}
