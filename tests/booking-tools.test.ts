// The booking tools carry NO business fact of any customer (the first
// customer's centres / weekdays / durations were hard-coded here and reached
// every tenant). The place is free text from the tenant's own sheet, and the
// `location` key is ALWAYS sent so the web applies no weekday rule.
// Run with:  npx tsx tests/booking-tools.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env['APP_URL'] = 'http://web.test';
process.env['INTERNAL_SECRET'] = 'mock';

const { makeCalendarTools } = await import('../tools/calendar.js');

// 1. No customer fact anywhere in the tool source (descriptions included).
const src = readFileSync(new URL('../tools/calendar.ts', import.meta.url), 'utf8');
for (const fact of [/ashdod/i, /natanya/i, /netanya/i, /j[ée]rusalem/i, /prestige/i, /johana/i, /soins? de la peau/i, /épilation/i, /LUNDI|MERCREDI/]) {
  assert.doesNotMatch(src, fact, `tools/calendar.ts still names ${fact}`);
}

// 2. The tool set: no list_available_dates (it only existed for that rule).
const tools = makeCalendarTools({ dialedPhone: '+97220000000', tenantUserId: '', features: { calendar: true, crm: false } });
assert.deepEqual(Object.keys(tools).sort(), [
  'book_appointment', 'cancel_appointment', 'check_availability', 'find_appointment', 'reschedule_appointment',
]);

// 3. Every place-aware request sends the `location` key (null when none).
const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body ?? '{}')) });
  const path = new URL(url).pathname;
  const reply =
    path === '/api/calendar/availability'
      ? { date: '2030-01-07', location: null, available_slots: ['10:00'] }
      : { success: true, summary: 'RDV confirmé.' };
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

type Exec = { execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown> };
const run = (name: keyof typeof tools, args: Record<string, unknown>) =>
  (tools[name] as unknown as Exec).execute(args, { ctx: {}, toolCallId: 't', abortSignal: undefined });

const out = await run('check_availability', { date: '2030-01-07' });
assert.equal(out, 'Le 2030-01-07, créneaux libres : 10:00');
await run('book_appointment', { name: 'Dana', phone: '+97250000000', date: '2030-01-07', time: '10:00', location: 'Salon Rivoli' });
await run('reschedule_appointment', { event_id: 'e1', new_date: '2030-01-08', new_time: '11:00' });
const byPath = Object.fromEntries(sent.map((s) => [s.path, s.body]));
assert.ok('location' in byPath['/api/calendar/availability'] && byPath['/api/calendar/availability'].location === null);
assert.equal(byPath['/api/calendar/book'].location, 'Salon Rivoli');
assert.ok(!('center' in byPath['/api/calendar/book']), 'no legacy centre is sent');
assert.ok('location' in byPath['/api/calendar/reschedule'] && byPath['/api/calendar/reschedule'].location === null);

console.log('ALL BOOKING-TOOLS TESTS PASSED');
process.exit(0);
