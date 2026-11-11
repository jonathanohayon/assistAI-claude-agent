// When the tenant config can't be loaded, the agent is NEVER another
// business's persona (it used to be "Johana du centre Prestige" for every
// tenant): inbound → the neutral message-taking fallback with no tool;
// outbound → refused (dropped before speaking). Every fallback emits
// config_fallback_used (an admin alert on the web).
// Run with:  npx tsx tests/config-fallback.test.ts
import assert from 'node:assert/strict';

process.env['INTERNAL_SECRET'] = 'mock';
const { fetchConfig, FALLBACK_FEATURES } = await import('../src/config-fetcher.js');
const { ConfigRefusedError } = await import('../src/config-refusal.js');
const { FALLBACK_INSTRUCTIONS, FALLBACK_GREETING } = await import('../src/fallback-persona.js');

const FACTS = /prestige|johana|j[ée]rusalem|ashdod|natanya|soins?|épilation|lundi|mercredi/i;
assert.doesNotMatch(FALLBACK_INSTRUCTIONS, FACTS);
assert.doesNotMatch(FALLBACK_GREETING, FACTS);
assert.match(FALLBACK_INSTRUCTIONS, /prendre un message/);

const config = await import('../config.js');
assert.ok(!('INSTRUCTIONS' in config) && !('GREETING_INSTRUCTIONS' in config), 'the Prestige persona is gone from config.ts');

type Reply = { status: number; body?: unknown } | 'timeout';
let reply: Reply = { status: 200 };
const events: Array<Record<string, unknown>> = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  if (path === '/api/events') {
    events.push(JSON.parse(String(init?.body)));
    return new Response('{"ok":true}', { status: 200 });
  }
  if (path.startsWith('/api/vox')) return new Response('{}', { status: 404 });
  if (reply === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const SIP = { kind: 'sip', calledNumber: '+97220000000', channel: 'pstn' } as const;
const CAMPAIGN = { kind: 'campaign', campaignId: 'c', contactId: 'k', userId: '' } as const;

const neutral = (cfg: Awaited<ReturnType<typeof fetchConfig>>, label: string) => {
  assert.equal(cfg.instructions, FALLBACK_INSTRUCTIONS, label);
  assert.equal(cfg.greetingInstructions, FALLBACK_GREETING, label);
  assert.deepEqual(cfg.features, FALLBACK_FEATURES, `${label}: no tools`);
  assert.equal(cfg.transferNumber, '', `${label}: no transfer`);
  assert.equal(cfg.ordersEnabled, false);
};
const lastEvent = () => events.at(-1) as { event: string; level: string; metadata: { code: string; outbound: boolean } };

// APP_URL unset: neutral (no web to report to; stdout only).
delete process.env['APP_URL'];
neutral(await fetchConfig(SIP), 'APP_URL unset');
process.env['APP_URL'] = 'http://web.test';

for (const [label, r, code] of [
  ['timeout', 'timeout', 'fetch_failed'],
  ['5xx', { status: 503 }, 'http_503'],
  ['401 secret mismatch', { status: 401 }, 'http_401'],
  ['200 without instructions', { status: 200, body: { model: 'x' } }, 'missing_instructions'],
  ['200 with blank instructions', { status: 200, body: { instructions: '  ' } }, 'missing_instructions'],
] as const) {
  reply = r as Reply;
  neutral(await fetchConfig(SIP), label);
  const ev = lastEvent();
  assert.equal(ev.event, 'config_fallback_used', label);
  assert.equal(ev.level, 'error');
  assert.equal(ev.metadata.code, code, label);
  assert.equal(ev.metadata.outbound, false);
}

// Outbound (we placed the call): refused, never a persona.
for (const r of ['timeout', { status: 500 }, { status: 200, body: {} }] as const) {
  reply = r as Reply;
  await assert.rejects(fetchConfig(CAMPAIGN), (e: unknown) => e instanceof ConfigRefusedError && e.reason === 'config_unavailable');
  assert.equal(lastEvent().metadata.outbound, true);
}

// Explicit refusals unchanged.
reply = { status: 404, body: { error: 'unknown_number' } };
await assert.rejects(fetchConfig(SIP), (e: unknown) => e instanceof ConfigRefusedError && e.reason === 'unknown_number');
reply = { status: 403, body: { error: 'trial_exhausted' } };
await assert.rejects(fetchConfig(SIP), (e: unknown) => e instanceof ConfigRefusedError && e.reason === 'trial_exhausted');

// A real config passes through, no fallback event.
const n = events.length;
reply = { status: 200, body: { instructions: 'TENANT PROMPT', greetingInstructions: 'HI', features: { calendar: true, crm: true, whatsapp_confirm: true, whatsapp_recap: true } } };
const ok = await fetchConfig(SIP);
assert.equal(ok.instructions, 'TENANT PROMPT');
assert.equal(ok.greetingInstructions, 'HI');
assert.equal(ok.features.calendar, true);
assert.equal(events.length, n);

console.log('ALL CONFIG-FALLBACK TESTS PASSED');
process.exit(0);
