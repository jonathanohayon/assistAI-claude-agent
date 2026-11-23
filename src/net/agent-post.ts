import https from 'node:https';

import { guardedLookup, UnsafeAddressError, type Resolver, type UnsafeReason } from './safe-url.js';

/**
 * The one HTTPS poster for every call to a customer's agent (the old own-agent
 * webhook today; ask_client_agent and T5c adopt it next).
 *
 * Contract:
 * - never rejects: every failure is an outcome;
 * - the socket connects only to an address checked at connect time
 *   (guardedLookup), so a pooled socket is one whose address was checked;
 * - the whole exchange (DNS, connect, TLS, response) fits in `budgetMs`, and
 *   that deadline is shared by the retry below, never extended;
 * - at most ONE retry, on a fresh connection, and only when a REUSED
 *   keep-alive socket fails with a network error before any response byte.
 *   That is the signature of a socket the customer's server (or a proxy in
 *   between) closed while it sat idle in our pool: the request never reached
 *   their application, so sending it again is safe. A timeout, an HTTP
 *   status, or an error on a fresh socket is a real failure and is returned
 *   as is.
 */

/** Largest reply body read from the customer's agent; beyond it → tooLarge. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Free sockets are closed after this long idle. It is kept below the most
 * common server-side idle timeout, Node's own 5 s `keepAliveTimeout` (also
 * uvicorn's default), with a 1 s margin for timer jitter and network delay:
 * we drop the socket before their server does, so we never write into one
 * it already closed. Servers with a shorter idle timeout exist (gunicorn's
 * default is 2 s), and a proxy can drop a flow without telling us; the
 * retry-once below remains the safety net for those.
 */
export const AGENT_SOCKET_IDLE_MS = 4000;

/** Builds a keep-alive pool whose free sockets close after `idleMs`. */
export function createAgentPool(idleMs: number = AGENT_SOCKET_IDLE_MS): https.Agent {
  return new https.Agent({ keepAlive: true, timeout: idleMs });
}

/**
 * Shared keep-alive pool: every socket in it was opened through
 * guardedLookup, so a reused socket is one whose address was checked.
 */
const sharedAgentPool = createAgentPool();

/** Injectable for tests: DNS resolver, the https request function, the pool. */
export interface AgentPostDeps {
  resolve?: Resolver;
  request?: typeof https.request;
  /**
   * Keep-alive pool to use. Defaults to the shared pool when `request` is not
   * injected; with an injected `request` and no `agent`, no pool is passed.
   */
  agent?: https.Agent;
}

export type AgentPostOutcome =
  | { kind: 'response'; status: number; text: string; tooLarge: boolean }
  | { kind: 'refused'; reason: UnsafeReason }
  | { kind: 'failed'; failure: 'timeout' | 'network' };

export interface AgentPostOptions {
  /** Overall deadline for the exchange, retry included. */
  budgetMs: number;
  maxResponseBytes?: number;
}

/** Errors that mean "the peer had already closed this socket". */
const STALE_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

function isStaleSocketError(err: NodeJS.ErrnoException): boolean {
  if (err.code && STALE_SOCKET_CODES.has(err.code)) return true;
  return err.message === 'socket hang up';
}

/**
 * POST `body` to `url` over node:https with a connect-time address check.
 * Never rejects. The body and headers (so the signature) are the same bytes
 * on the retry.
 */
export function postToAgent(
  url: URL,
  headers: Record<string, string>,
  body: string,
  options: AgentPostOptions,
  deps: AgentPostDeps = {},
): Promise<AgentPostOutcome> {
  const request = deps.request ?? https.request;
  const pool = deps.agent ?? (deps.request ? undefined : sharedAgentPool);
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const requestHeaders = { ...headers, 'Content-Length': String(Buffer.byteLength(body)) };

  return new Promise<AgentPostOutcome>((resolve) => {
    let settled = false;
    let current: ReturnType<typeof https.request> | null = null;

    const done = (outcome: AgentPostOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    // One deadline for the whole exchange: the retry runs inside it.
    const timer = setTimeout(() => {
      done({ kind: 'failed', failure: 'timeout' });
      current?.destroy();
    }, options.budgetMs);

    const attempt = (agent: https.Agent | false | undefined, isRetry: boolean) => {
      let responded = false;
      const req = request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: requestHeaders,
          lookup: guardedLookup(deps.resolve),
          agent,
        },
        (res) => {
          responded = true;
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
            if (size > maxBytes) {
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
      current = req;

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (err instanceof UnsafeAddressError) {
          done({ kind: 'refused', reason: err.reason });
          return;
        }
        if (!isRetry && !responded && req.reusedSocket && isStaleSocketError(err)) {
          // The stale socket is already destroyed by the error; `agent: false`
          // guarantees a brand-new connection rather than another pooled one.
          console.log(
            `[agent_post] retry on fresh connection after ${err.code ?? 'socket hang up'} on reused socket`,
          );
          attempt(false, true);
          return;
        }
        done({ kind: 'failed', failure: 'network' });
      });
      req.end(body);
    };

    attempt(pool, false);
  });
}
