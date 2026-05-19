// Sonde infra région — exécutée 1x au démarrage du worker pour mesurer
// les RTT réels depuis le container LK Cloud Agent vers chaque hop critique :
// Twilio, LK SFU, OpenAI Realtime endpoint.
//
// Les mesures sont loggées via un event `infra_region_probe` visible dans
// /dashboard/logs (onglet Monitoring), permettant de corréler les labels
// déclarés (env INFRA_*) avec ce que le worker observe réellement.

import { remoteLog } from './remote-log.js';

interface ProbeResult {
  host: string;
  label: string;
  dns_ms: number | null;
  connect_ms: number | null;
  total_ms: number | null;
  resolved_ips: string[];
  error?: string;
}

/**
 * Mesure RTT TCP + DNS vers un host:port via fetch HEAD (suit la même
 * route réseau qu'une vraie requête HTTPS depuis le worker).
 */
async function probeOne(label: string, url: string): Promise<ProbeResult> {
  const u = new URL(url);
  const result: ProbeResult = {
    host: u.hostname,
    label,
    dns_ms: null,
    connect_ms: null,
    total_ms: null,
    resolved_ips: [],
  };

  // DNS resolve via Node DNS module — Node n'expose pas le timing fetch
  // séparé pour DNS/connect en pur Node sans curl, donc on mesure le
  // total via fetch et on DNS-resolve à part pour avoir les IPs.
  try {
    const dns = await import('node:dns');
    const t0 = Date.now();
    const all = await dns.promises.lookup(u.hostname, { all: true });
    result.dns_ms = Date.now() - t0;
    result.resolved_ips = all.map((a) => a.address);
  } catch (e) {
    result.error = `dns: ${(e as Error).message}`;
    return result;
  }

  try {
    const t1 = Date.now();
    // HEAD pour minimiser le payload — on ne mesure que le handshake TCP+TLS
    // + le RTT au serveur (qui répond avec un code HTTP).
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });
    result.total_ms = Date.now() - t1;
    // connect ≈ total - négligeable (HEAD réponse ~0 ms côté serveur)
    result.connect_ms = result.total_ms;
    // Status code dans error si non-2xx (juste pour diag, pas un échec)
    if (res.status >= 500) {
      result.error = `http ${res.status}`;
    }
  } catch (e) {
    result.error = `connect: ${(e as Error).message}`;
  }

  return result;
}

/**
 * Probe les 4 hops critiques depuis le worker.
 * Émet un event `infra_region_probe` (level info) avec les résultats.
 * Non-bloquant : si la sonde échoue ou prend trop de temps, on log et on
 * continue sans planter le worker.
 */
export async function probeRegionsAtStartup(): Promise<void> {
  const startedAt = Date.now();

  const lkUrl = process.env['LIVEKIT_URL'] ?? '';
  const lkHttps = lkUrl.replace(/^wss?:\/\//, 'https://').replace(/^http:\/\//, 'https://');

  const realtimeBase = process.env['REALTIME_API_BASE'] ?? 'https://api.openai.com/v1';

  const targets: Array<[string, string]> = [
    ['Twilio API', 'https://api.twilio.com'],
    ['Twilio Trunking', 'https://trunking.twilio.com'],
    ['LK SFU signaling', lkHttps || 'https://livekit.cloud'],
    ['OpenAI Realtime', realtimeBase],
    ['Tamara web', process.env['APP_URL'] ?? 'https://aitamara.com'],
  ];

  const results = await Promise.all(
    targets.map(([label, url]) => probeOne(label, url)),
  );

  const elapsed = Date.now() - startedAt;

  // Build a human-readable summary
  const summary = results
    .map((r) => {
      if (r.error) return `${r.label}: ✗ ${r.error}`;
      return `${r.label}: ${r.total_ms}ms (dns ${r.dns_ms}ms) · ${r.resolved_ips.join('/')}`;
    })
    .join(' | ');

  await remoteLog(
    'infra',
    'infra_region_probe',
    `🌍 Region probe worker → infra · total ${elapsed}ms · ${summary}`,
    'info',
    {
      elapsedMs: elapsed,
      workerRegion: process.env['INFRA_WORKER_REGION'] ?? null,
      declaredTopology: {
        twilio: process.env['INFRA_TWILIO_EDGE'] ?? null,
        worker: process.env['INFRA_WORKER_REGION'] ?? null,
        web: process.env['INFRA_WEB_REGION'] ?? null,
        livekit: process.env['INFRA_LIVEKIT_REGION'] ?? null,
        openai: process.env['INFRA_OPENAI_REGION'] ?? null,
      },
      measuredHops: results,
    },
  );
}
