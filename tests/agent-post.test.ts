import assert from 'node:assert/strict';

import { callAgentWebhook } from '../src/agent-webhook.js';
import { createAgentPool, postToAgent } from '../src/net/agent-post.js';
import { depsWith, startServer } from './helpers/agent-test-server.js';

// Capture the retry log line.
const logs: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('[agent_post]')) logs.push(line);
  realLog(...args);
};
const retries = () => logs.filter((l) => l.startsWith('[agent_post] retry on fresh connection')).length;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = (port: number) => new URL(`https://agent.example.com:${port}/turn`);
const headers = { 'Content-Type': 'application/json', 'X-Tamara-Signature': 'abc123' };
const body = JSON.stringify({ turn_id: 1, transcript: 'Quels sont vos horaires ?' });

async function run(name: string, fn: () => Promise<void>) {
  logs.length = 0;
  await fn();
  realLog(`  ok - ${name}`);
}

await run('server closing the socket after each response: both requests succeed', async () => {
  const server = await startServer('close-after-response');
  const pool = createAgentPool();
  const a = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  await sleep(1000);
  const b = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.equal(a.kind, 'response');
  assert.equal(b.kind, 'response');
  assert.ok(retries() <= 1, 'never more than one retry');
  pool.destroy();
  await server.close();
});

await run('server that dropped the idle connection: second request succeeds via exactly one retry', async () => {
  const server = await startServer('drop-after-response');
  const pool = createAgentPool();
  const a = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  await sleep(1000);
  const b = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.equal(a.kind, 'response');
  assert.equal(b.kind, 'response');
  if (b.kind === 'response') assert.equal(b.status, 200);
  assert.equal(retries(), 1);
  assert.equal(logs[0], '[agent_post] retry on fresh connection after ECONNRESET on reused socket');
  assert.equal(server.seen.length, 3, 'first, failed reuse, retry');
  assert.equal(server.seen[1]!.socketId, server.seen[0]!.socketId, 'the failed attempt reused the socket');
  assert.notEqual(server.seen[2]!.socketId, server.seen[1]!.socketId, 'the retry used a fresh connection');
  pool.destroy();
  await server.close();
});

await run('server with a 1 s keep-alive, requests 2 s apart: success', async () => {
  const server = await startServer('ok', { keepAliveMs: 1000 });
  const pool = createAgentPool();
  const a = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  await sleep(2000);
  const b = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.equal(a.kind, 'response');
  assert.equal(b.kind, 'response');
  assert.ok(retries() <= 1);
  pool.destroy();
  await server.close();
});

await run('the pool closes idle sockets itself before the server does', async () => {
  const server = await startServer('drop-after-response');
  const pool = createAgentPool(300);
  await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.equal(Object.values(pool.freeSockets).flat().length, 1, 'socket kept alive after the response');
  await sleep(700);
  assert.equal(Object.values(pool.freeSockets).flat().length, 0, 'idle socket closed by the pool');
  const b = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.equal(b.kind, 'response');
  assert.equal(retries(), 0, 'no stale socket, so no retry needed');
  pool.destroy();
  await server.close();
});

await run('a reset on the reused socket near the deadline: the retry shares the deadline', async () => {
  const server = await startServer('ok');
  const pool = createAgentPool();
  await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  const first = server.seen[0]!.socketId;
  server.override = ({ socketId }, _res, sock) => {
    // Reused socket: reset late. Fresh socket: never answer.
    if (socketId === first) setTimeout(() => sock.destroy(), 250);
    return true;
  };
  const started = Date.now();
  const out = await postToAgent(url(server.port), headers, body, { budgetMs: 500 }, depsWith(pool));
  const elapsed = Date.now() - started;
  assert.deepEqual(out, { kind: 'failed', failure: 'timeout' });
  assert.equal(retries(), 1);
  assert.ok(elapsed >= 480 && elapsed < 700, `deadline not extended (${elapsed}ms)`);
  pool.destroy();
  await server.close();
});

await run('a reset on the reused socket after the deadline: timeout, no retry', async () => {
  const server = await startServer('ok');
  const pool = createAgentPool();
  await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  server.override = (_req, _res, sock) => {
    setTimeout(() => sock.destroy(), 700);
    return true;
  };
  const out = await postToAgent(url(server.port), headers, body, { budgetMs: 400 }, depsWith(pool));
  assert.deepEqual(out, { kind: 'failed', failure: 'timeout' });
  await sleep(500);
  assert.equal(retries(), 0);
  assert.equal(server.seen.length, 2);
  pool.destroy();
  await server.close();
});

await run('a network error on a fresh socket: no retry', async () => {
  const server = await startServer('reset-always');
  const pool = createAgentPool();
  const out = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.deepEqual(out, { kind: 'failed', failure: 'network' });
  assert.equal(retries(), 0);
  assert.equal(server.seen.length, 1);
  pool.destroy();
  await server.close();
});

await run('an HTTP 500 on a reused socket: no retry', async () => {
  const server = await startServer('ok');
  const pool = createAgentPool();
  await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  server.override = (_req, res) => {
    res.writeHead(500);
    res.end();
    return true;
  };
  const out = await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  assert.equal(out.kind, 'response');
  if (out.kind === 'response') assert.equal(out.status, 500);
  assert.equal(retries(), 0);
  assert.equal(server.seen.length, 2);
  pool.destroy();
  await server.close();
});

await run('a timeout on a reused socket: no retry', async () => {
  const server = await startServer('ok');
  const pool = createAgentPool();
  await postToAgent(url(server.port), headers, body, { budgetMs: 2000 }, depsWith(pool));
  server.override = () => true; // never answers
  const out = await postToAgent(url(server.port), headers, body, { budgetMs: 300 }, depsWith(pool));
  assert.deepEqual(out, { kind: 'failed', failure: 'timeout' });
  await sleep(100);
  assert.equal(retries(), 0);
  assert.equal(server.seen.length, 2);
  pool.destroy();
  await server.close();
});

await run('repro: the old webhook turn 1, ~1 s after the greeting, gets its answer; same signature and body on the retry', async () => {
  const server = await startServer('drop-after-response');
  const pool = createAgentPool();
  const config = { url: `https://agent.example.com:${server.port}/turn`, secret: 'mock-secret' };
  const deps = depsWith(pool);
  const turn = (turnId: number, transcript: string) =>
    callAgentWebhook(config, { roomName: 'call-mock-room', turnId, language: 'fr', transcript, history: [] }, deps);

  const greeting = await turn(0, '');
  assert.equal(greeting.reply, 'Nous sommes ouverts de 9 h à 18 h.');
  await sleep(1000);
  const answer = await turn(1, 'Quels sont vos horaires ?');
  assert.equal(answer.failure, undefined);
  assert.equal(answer.reply, 'Nous sommes ouverts de 9 h à 18 h.');
  assert.equal(retries(), 1);

  const [failed, retried] = [server.seen[1]!, server.seen[2]!];
  assert.ok(failed.headers['x-tamara-signature'], 'request is signed');
  assert.equal(retried.headers['x-tamara-signature'], failed.headers['x-tamara-signature']);
  assert.equal(retried.body, failed.body);
  pool.destroy();
  await server.close();
});

console.log = realLog;
console.log('agent-post: ok');
