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
import { resolveVoiceProfile } from './voice-profile.js';

interface ContractJson {
  version: number;
  voiceGender: Record<string, 'f' | 'm'>;
  defaultVoiceId: string;
  styles: string[];
  defaultStyle: string;
  engines: string[];
  defaultVoice: Record<string, unknown>;
  /** V6 style presets per engine; "warm" is empty (= today). */
  stylePresets: Record<string, Record<RealtimeProvider, { instruction: string; speedFactor: number }>>;
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
  const provider: RealtimeProvider = engine === 'auto' ? 'openai' : engine;
  // Style preset (V6, from the shared contract). Unknown style → warm (= today).
  const presets = VOICE_CONTRACT.stylePresets;
  const preset = (presets[String(vc['style'])] ?? presets['warm'])![provider]!;
  const ownStyle = typeof a['speakingStyle'] === 'string' ? a['speakingStyle'] : '';
  const baseSpeed = typeof a['speed'] === 'number' ? a['speed'] : 1;
  return {
    realtimeProvider: provider,
    model: typeof a['model'] === 'string' && a['model'] ? a['model'] : REALTIME_CONFIG.model,
    voice: vc['voiceId'],
    speed: preset.speedFactor === 1 ? baseSpeed : Math.round(baseSpeed * preset.speedFactor * 1000) / 1000,
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
      // No preset text → the tenant's line verbatim (same as the web).
      speakingStyle: preset.instruction ? [preset.instruction, ownStyle.trim()].filter(Boolean).join(' ') : a['speakingStyle'],
      languageLock: vc['languageLock'],
      openaiTurnMode: a['openaiTurnMode'],
      openaiEagerness: a['openaiEagerness'],
      openaiNoiseReduction: a['openaiNoiseReduction'],
      openaiReasoning: a['openaiReasoning'],
      grokReasoning: a['grokReasoning'],
    },
  };
}

/** Keys whose values differ between two engine settings (deep compare). */
export function engineMismatch(a: EngineSettings, b: EngineSettings): string[] {
  const keys: Array<keyof EngineSettings> = ['realtimeProvider', 'model', 'voice', 'speed', 'noiseReductionLevel', 'voiceProfile'];
  const canon = (v: unknown) =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
        : x,
    );
  // Profiles are compared as the worker uses them (resolved): an outbound
  // payload has no legacy profile, which resolves to the defaults.
  const norm = (e: EngineSettings) => ({ ...e, voiceProfile: resolveVoiceProfile(e.voiceProfile) });
  const na = norm(a);
  const nb = norm(b);
  return keys.filter((k) => canon(na[k]) !== canon(nb[k]));
}

/**
 * The one entry point: voiceConfig when valid, legacy fields otherwise.
 * Shadow compare: when voiceConfig is the source and the payload ALSO has
 * the legacy fields, any difference is reported in `mismatch` (and logged by
 * the caller), so drift between the two shows up on real calls.
 */
export function resolveEngineSettings(
  data: Record<string, unknown>,
): EngineSettings & { source: 'voiceConfig' | 'legacy'; mismatch: string[] } {
  const fromContract = engineFromVoiceConfig(data['voiceConfig']);
  if (!fromContract) return { ...engineFromLegacy(data), source: 'legacy', mismatch: [] };
  const hasLegacy = 'voice' in data || 'model' in data || 'speed' in data;
  const legacy = engineFromLegacy(data);
  return { ...fromContract, source: 'voiceConfig', mismatch: hasLegacy ? engineMismatch(fromContract, legacy) : [] };
}
