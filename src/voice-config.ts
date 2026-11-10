/**
 * Voice contract → engine settings: ONE mapping for every call type
 * (inbound, campaign, outbound test, vox).
 *
 * The web (≥ #185) serves the Voice contract as `voiceConfig` next to the
 * legacy fields. When a valid v1 `voiceConfig` is present it is the source;
 * otherwise the legacy fields are read exactly as before. Both paths give
 * the same settings for the same agent (tests/voice-config.test.ts, on the
 * web's real route payloads).
 *
 * The shared rules (gender table, enums, defaults, mapping examples) come
 * from src/voice/contract.json, vendored byte-for-byte from the web's
 * lib/voice/contract.json — tests fail when the copies differ.
 */
import { readFileSync } from 'node:fs';

import { REALTIME_CONFIG } from '../config.js';
import { DEFAULT_NOISE_REDUCTION_LEVEL } from './constants.js';
import type { RealtimeProvider } from './realtime-provider.js';

interface ContractJson {
  version: number;
  voiceGender: Record<string, 'f' | 'm'>;
  defaultVoiceId: string;
  styles: string[];
  defaultStyle: string;
  engines: string[];
  defaultVoice: Record<string, unknown>;
  examples: Array<{ voice: unknown; engine: EngineSettings }>;
}

export const VOICE_CONTRACT: ContractJson = JSON.parse(
  readFileSync(new URL('./voice/contract.json', import.meta.url), 'utf8'),
);

/** OpenAI voices the contract marks male (Gemini/Grok fallback mapping). */
export const MALE_VOICE_IDS = new Set(
  Object.entries(VOICE_CONTRACT.voiceGender).filter(([, g]) => g === 'm').map(([id]) => id),
);

/** The six settings the voice engine is built from (same as the web's toEngineSettings). */
export interface EngineSettings {
  realtimeProvider: RealtimeProvider;
  model: string;
  voice: string;
  speed: number;
  noiseReductionLevel: number;
  /** Raw voice profile; agent.ts resolves it (resolveVoiceProfile). */
  voiceProfile: unknown;
}

const nrl = (v: unknown): number =>
  typeof v === 'number' ? Math.min(10, Math.max(1, Math.round(v))) : DEFAULT_NOISE_REDUCTION_LEVEL;

/** Legacy fields, read exactly as fetchConfig did before the contract. */
export function engineFromLegacy(data: Record<string, unknown>): EngineSettings {
  return {
    realtimeProvider:
      data['realtimeProvider'] === 'gemini' || data['realtimeProvider'] === 'xai'
        ? data['realtimeProvider']
        : 'openai',
    model: (data['model'] as string | undefined) ?? REALTIME_CONFIG.model,
    voice: (data['voice'] as string | undefined) ?? REALTIME_CONFIG.voice,
    speed: (data['speed'] as number | undefined) ?? REALTIME_CONFIG.speed,
    noiseReductionLevel: nrl(data['noiseReductionLevel']),
    voiceProfile: data['voiceProfile'],
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ENGINES = new Set(VOICE_CONTRACT.engines);

/**
 * A v1 voiceConfig → engine settings, or null if it isn't one (then the
 * caller falls back to the legacy fields). Mirrors the web's toEngineSettings.
 */
export function engineFromVoiceConfig(vc: unknown): EngineSettings | null {
  if (!isObj(vc) || vc['version'] !== VOICE_CONTRACT.version) return null;
  const a = vc['advanced'];
  if (!isObj(a)) return null;
  if (typeof vc['voiceId'] !== 'string' || !vc['voiceId']) return null;
  if (typeof vc['engine'] !== 'string' || !ENGINES.has(vc['engine'])) return null;
  const engine = vc['engine'] as 'auto' | RealtimeProvider;
  return {
    realtimeProvider: engine === 'auto' ? 'openai' : engine,
    model: typeof a['model'] === 'string' && a['model'] ? a['model'] : REALTIME_CONFIG.model,
    voice: vc['voiceId'],
    speed: typeof a['speed'] === 'number' ? a['speed'] : 1,
    noiseReductionLevel: nrl(vc['noiseReduction']),
    voiceProfile: {
      turnSensitivity: vc['patience'],
      bargeIn: vc['bargeIn'],
      keyTerms: vc['keyTerms'],
      languageHint: a['languageHint'],
      voiceOverrides: a['voiceOverrides'],
      minInterruptionMs: a['minInterruptionMs'],
      idleHangupSec: a['idleHangupSec'],
      maxDurationMin: a['maxDurationMin'],
      pace: vc['pace'],
      pronunciations: vc['pronunciations'],
      fillers: a['fillers'],
      speakingStyle: a['speakingStyle'],
      languageLock: vc['languageLock'],
      openaiTurnMode: a['openaiTurnMode'],
      openaiEagerness: a['openaiEagerness'],
      openaiNoiseReduction: a['openaiNoiseReduction'],
      openaiReasoning: a['openaiReasoning'],
      grokReasoning: a['grokReasoning'],
    },
  };
}

/** The one entry point: voiceConfig when valid, legacy fields otherwise. */
export function resolveEngineSettings(data: Record<string, unknown>): EngineSettings & { source: 'voiceConfig' | 'legacy' } {
  const fromContract = engineFromVoiceConfig(data['voiceConfig']);
  return fromContract ? { ...fromContract, source: 'voiceConfig' } : { ...engineFromLegacy(data), source: 'legacy' };
}
