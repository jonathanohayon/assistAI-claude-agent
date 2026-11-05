/**
 * Worker heartbeat -> web POST /api/agent/heartbeat, every 5 minutes.
 *
 * The web's monitor cron alerts the founder when heartbeats stop for 12 min:
 * the worker is down, OR its INTERNAL_SECRET no longer matches the web (every
 * call would then silently run on the default persona). The heartbeat also
 * carries hourly READ-ONLY checks of the model keys the worker holds (list
 * models; status only, never the key).
 */
import { webPost } from './web-api.js';

export type KeyState = 'ok' | 'invalid' | 'unreachable' | 'missing';
type Provider = 'openai' | 'gemini' | 'xai';

const HEARTBEAT_MS = 5 * 60_000;
const KEY_CHECK_MS = 60 * 60_000;

/** HTTP status of a list-models call -> key state. Gemini answers a bad key with 400. */
export function keyStateFromStatus(provider: Provider, status: number): KeyState {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401 || status === 403) return 'invalid';
  if (provider === 'gemini' && status === 400) return 'invalid';
  return 'unreachable';
}

const CHECKS: Record<Provider, { env: string; url: string; headers: (k: string) => Record<string, string> }> = {
  openai: { env: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  gemini: {
    env: 'GOOGLE_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: (k) => ({ 'x-goog-api-key': k }),
  },
  xai: { env: 'XAI_API_KEY', url: 'https://api.x.ai/v1/models', headers: (k) => ({ Authorization: `Bearer ${k}` }) },
};

export async function checkKeys(fetchImpl: typeof fetch = fetch): Promise<Record<Provider, KeyState>> {
  const out = {} as Record<Provider, KeyState>;
  for (const p of Object.keys(CHECKS) as Provider[]) {
    const c = CHECKS[p];
    const key = process.env[c.env]?.trim();
    if (!key) {
      out[p] = 'missing';
      continue;
    }
    try {
      const res = await fetchImpl(c.url, { headers: c.headers(key), signal: AbortSignal.timeout(8_000) });
      await res.arrayBuffer().catch(() => undefined);
      out[p] = keyStateFromStatus(p, res.status);
    } catch {
      out[p] = 'unreachable';
    }
  }
  return out;
}

/**
 * True in the main worker process only. LiveKit agents (1.9.5) FORKS every job
 * and inference process from its own entry script (ipc/job_proc_lazy_main.js,
 * ipc/inference_proc_lazy_main.js) and those import this module too, so code
 * here would otherwise run once per pooled process, and die with it. The entry
 * script (argv[1]) tells them apart; process.send isn't reliable under tsx.
 */
export function isWorkerMainProcess(argv: readonly string[] = process.argv): boolean {
  return !/(job|inference)_proc_lazy_main\.(c?js|mjs)$/.test(argv[1] ?? '');
}

let started = false;

/** Starts the heartbeat ONCE, in the main worker process (best-effort, never throws). */
export function startHeartbeat(info: { agentName: string; version: string }): void {
  if (started || !isWorkerMainProcess()) return;
  if (!process.env['APP_URL'] || !process.env['INTERNAL_SECRET']) return;
  started = true;
  console.log(`[heartbeat] started in main worker process pid=${process.pid}`);
  let keys: Record<Provider, KeyState> | undefined;
  let keysAt = 0;
  const beat = async () => {
    try {
      if (!keys || Date.now() - keysAt >= KEY_CHECK_MS) {
        keys = await checkKeys();
        keysAt = Date.now();
      }
      const res = await webPost('/api/agent/heartbeat', { ...info, keys }, { timeoutMs: 8_000 });
      if (!res.ok) console.error(`[heartbeat] /api/agent/heartbeat -> ${res.status}`);
    } catch (e) {
      console.error(`[heartbeat] failed: ${(e as Error).message}`);
    }
  };
  void beat();
  setInterval(() => void beat(), HEARTBEAT_MS).unref();
}
