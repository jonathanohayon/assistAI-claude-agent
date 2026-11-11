import { createHmac } from 'node:crypto';
import https from 'node:https';

import {
  checkUrlShape,
  guardedLookup,
  UnsafeAddressError,
  type Resolver,
  type UnsafeReason,
} from './net/safe-url.js';
import { remoteLog } from './remote-log.js';
import { callIdFromRoomName } from './session-context.js';

/**
 * Mode « agent webhook » (BYO-agent) — le cerveau vit chez le client.
 *
 * En mode normal, le modèle Realtime écoute ET répond. Ici il ne fait plus
 * que l'oreille et la voix : à chaque tour, on POSTe la transcription au
 * endpoint du client, et on fait prononcer le texte qu'il renvoie.
 *
 * Deux décisions structurantes :
 *
 * 1. Ce n'est PAS implémenté comme un tool Realtime. Le SDK laisse tomber un
 *    tool call quand le modèle combine audio de remplissage et appel d'outil
 *    (bug constaté en prod, cf. take_message retiré le 2026-05-13). L'appel
 *    réseau est donc découplé du flux vocal : on écoute l'événement de
 *    transcription, on appelle, on parle.
 *
 * 2. Le budget est ferme. Sur un appel, un silence est indistinguable d'une
 *    ligne coupée : on préfère prononcer une phrase d'attente à l'heure
 *    plutôt qu'une réponse parfaite trop tard.
 */

/** Fenêtre laissée à l'agent client. Au-delà, c'est du blanc à l'antenne. */
export const TURN_BUDGET_MS = 2000;

export interface AgentWebhookConfig {
  url: string;
  /** Secret HMAC. Sans lui la requête part non signée (le client ne peut pas vérifier). */
  secret?: string;
}

export interface WebhookTurn {
  role: 'user' | 'agent';
  text: string;
}

/** Phrases de repli, par langue — jamais de silence. */
const STALL: Record<string, string> = {
  fr: 'Un instant, je vérifie.',
  he: 'רגע אחד, אני בודקת.',
  en: 'One moment, let me check.',
};

export function stallLine(language: string): string {
  return STALL[language] ?? STALL['en']!;
}

/** Injectable for tests: DNS resolver and the https request function. */
export interface WebhookDeps {
  resolve?: Resolver;
  request?: typeof https.request;
}

export interface WebhookResult {
  reply: string | null;
  elapsedMs: number;
  /** Pourquoi on n'a pas de réponse — pour les logs, pas pour l'appelant. */
  failure?: 'timeout' | 'http' | 'shape' | 'network' | 'unsafe_url';
  status?: number;
}

/**
 * Request body sent to the customer's endpoint. `call_id` is the same hashed
 * id our web receives (callIdFromRoomName): stable across the turns of one
 * call, and free of the caller's number carried by the raw room name.
 */
export function webhookRequestBody(params: {
  roomName: string;
  turnId: number;
  language: string;
  transcript: string;
  history: WebhookTurn[];
}): {
  call_id: string;
  turn_id: number;
  language: string;
  transcript: string;
  history: WebhookTurn[];
} {
  return {
    call_id: callIdFromRoomName(params.roomName),
    turn_id: params.turnId,
    language: params.language,
    transcript: params.transcript,
    // Fenêtre glissante : l'historique complet d'un appel long ferait grossir
    // la charge utile à chaque tour, au détriment du budget.
    history: params.history.slice(-12),
  };
}

/**
 * Appelle l'agent du client pour un tour de parole.
 *
 * Ne throw jamais : un échec renvoie `reply: null` et l'appelant décide quoi
 * prononcer. Couper l'appel parce que le endpoint du client est tombé serait
 * la pire réaction possible.
 */
export async function callAgentWebhook(
  config: AgentWebhookConfig,
  params: {
    /**
     * Raw LiveKit room name. Never sent as is: SIP room names embed the
     * caller's number, so the customer's endpoint only gets its hash.
     */
    roomName: string;
    turnId: number;
    language: string;
    transcript: string;
    history: WebhookTurn[];
  },
  deps: WebhookDeps = {},
): Promise<WebhookResult> {
  const body = JSON.stringify(webhookRequestBody(params));

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Tamara-Voice/1.0',
  };
  if (config.secret) {
    headers['X-Tamara-Signature'] = createHmac('sha256', config.secret)
      .update(body)
      .digest('hex');
  }

  const startedAt = Date.now();

  // Cheap early refusal on the URL alone (scheme, credentials, internal
  // hostname, IP literal). DNS is checked once, at connect time, by the
  // socket's own lookup — see postToAgent.
  const shape = checkUrlShape(config.url);
  if (!shape.ok) return refused(shape.reason, startedAt);

  const outcome = await postToAgent(new URL(config.url), headers, body, deps);
  const elapsedMs = Date.now() - startedAt;

  if (outcome.kind === 'refused') {
    if (outcome.reason === 'dns_failure') return { reply: null, elapsedMs, failure: 'network' };
    return refused(outcome.reason, startedAt);
  }
  if (outcome.kind === 'failed') return { reply: null, elapsedMs, failure: outcome.failure };

  // No redirects are followed: a 3xx is a failed turn, like any non-2xx.
  if (outcome.status < 200 || outcome.status >= 300) {
    return { reply: null, elapsedMs, failure: 'http', status: outcome.status };
  }
  if (outcome.tooLarge) {
    return { reply: null, elapsedMs, failure: 'shape', status: outcome.status };
  }

  let reply: string | null = null;
  try {
    const parsed = JSON.parse(outcome.text) as { reply?: unknown };
    if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
      reply = parsed.reply.trim();
    }
  } catch {
    // Corps non-JSON → traité comme une réponse mal formée.
  }

  if (!reply) {
    return { reply: null, elapsedMs, failure: 'shape', status: outcome.status };
  }
  return { reply, elapsedMs, status: outcome.status };
}

/** A refused URL: failed turn, no request, one log with the reason only. */
function refused(reason: UnsafeReason, startedAt: number): WebhookResult {
  // No URL and no address in the log: the reason is enough to act on.
  void remoteLog(
    'agent',
    'agent_webhook_unsafe_url',
    `Agent webhook URL refused (${reason}); no request sent`,
    'error',
    { reason },
  );
  return { reply: null, elapsedMs: Date.now() - startedAt, failure: 'unsafe_url' };
}

/** Largest reply body read from the customer's agent; beyond it → 'shape'. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Dedicated keep-alive pool: every socket in it was opened through
 * guardedLookup, so a reused socket is one whose address was checked.
 */
const webhookAgent = new https.Agent({ keepAlive: true });

type PostOutcome =
  | { kind: 'response'; status: number; text: string; tooLarge: boolean }
  | { kind: 'refused'; reason: UnsafeReason }
  | { kind: 'failed'; failure: 'timeout' | 'network' };

/**
 * POST over node:https with a connect-time address check. Never rejects.
 * The whole exchange (DNS, connect, TLS, response) fits in TURN_BUDGET_MS.
 */
function postToAgent(
  url: URL,
  headers: Record<string, string>,
  body: string,
  deps: WebhookDeps,
): Promise<PostOutcome> {
  const request = deps.request ?? https.request;
  return new Promise<PostOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: PostOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const req = request(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: guardedLookup(deps.resolve),
        agent: deps.request ? undefined : webhookAgent,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          done({ kind: 'response', status, text: '', tooLarge: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            done({ kind: 'response', status, text: '', tooLarge: true });
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          done({ kind: 'response', status, text: Buffer.concat(chunks).toString('utf8'), tooLarge: false });
        });
        res.on('error', () => done({ kind: 'failed', failure: 'network' }));
      },
    );

    const timer = setTimeout(() => {
      done({ kind: 'failed', failure: 'timeout' });
      req.destroy();
    }, TURN_BUDGET_MS);

    req.on('error', (err: Error) => {
      if (err instanceof UnsafeAddressError) done({ kind: 'refused', reason: err.reason });
      else done({ kind: 'failed', failure: 'network' });
    });
    req.end(body);
  });
}
