// Shared by agent-post.test.ts and client-agent.test.ts: a local HTTPS
// server and a loopback https.request for the shared poster
// (src/net/agent-post.ts). Not a test file itself (npm test runs
// tests/*.test.ts only).
import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';

import type { AgentPostDeps } from '../../src/net/agent-post.js';

// Local HTTPS server on 127.0.0.1 with a test-only self-signed certificate.
// No real network: the hostname is resolved to loopback by the test lookup.
const tls = {
  key: readFileSync(new URL('../fixtures/test-only-self-signed.key', import.meta.url)),
  cert: readFileSync(new URL('../fixtures/test-only-self-signed.crt', import.meta.url)),
};

export type Mode =
  /** Answers, then destroys the socket right after the response. */
  | 'close-after-response'
  /**
   * Answers, then forgets the connection without telling the client (what a
   * proxy or NAT that dropped an idle flow looks like): any later request on
   * that socket is read, then the socket is destroyed with no response.
   */
  | 'drop-after-response'
  /** Destroys every connection on its first request (fresh-socket failure). */
  | 'reset-always'
  | 'ok';

export interface Seen { socketId: number; headers: Record<string, string | string[] | undefined>; body: string }

export interface TestServer {
  port: number;
  seen: Seen[];
  /** Per-request override: return true when the request was handled. */
  override: ((req: { socketId: number; served: number }, res: import('node:http').ServerResponse, sock: Socket) => boolean) | null;
  close: () => Promise<void>;
}

export async function startServer(mode: Mode, opts: { keepAliveMs?: number } = {}): Promise<TestServer> {
  let nextId = 0;
  const ids = new WeakMap<Socket, { id: number; served: number }>();
  const sockets = new Set<Socket>();
  const state: TestServer = { port: 0, seen: [], override: null, close: async () => {} };

  const server = https.createServer(tls, (req, res) => {
    const sock = req.socket;
    const info = ids.get(sock)!;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.seen.push({ socketId: info.id, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (state.override?.({ socketId: info.id, served: info.served }, res, sock)) return;
      if (mode === 'reset-always' || (mode === 'drop-after-response' && info.served > 0)) {
        sock.destroy();
        return;
      }
      info.served += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: 'Nous sommes ouverts de 9 h à 18 h.' }));
      if (mode === 'close-after-response') res.on('finish', () => sock.destroy());
    });
  });
  server.keepAliveTimeout = opts.keepAliveMs ?? 60_000;
  server.on('secureConnection', (sock: Socket) => {
    ids.set(sock, { id: ++nextId, served: 0 });
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return state;
}

// Real https.request, pointed at loopback and trusting the self-signed cert.
// (The connect-time address guard is covered by agent-webhook.test.ts.)
const loopbackLookup = ((_h: string, o: unknown, cb?: unknown) => {
  const callback = (typeof o === 'function' ? o : cb) as (...a: unknown[]) => void;
  const all = typeof o === 'object' && o !== null && (o as { all?: boolean }).all;
  if (all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
}) as unknown as https.RequestOptions['lookup'];

export const loopbackRequest = ((options: https.RequestOptions, cb: Parameters<typeof https.request>[1]) =>
  https.request({ ...options, lookup: loopbackLookup, rejectUnauthorized: false }, cb)) as unknown as typeof https.request;

export function depsWith(agent: https.Agent): AgentPostDeps {
  return { request: loopbackRequest, agent };
}

