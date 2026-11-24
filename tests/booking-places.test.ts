// The booking tools offer the account's own places, never the first
// customer's centres. Covers: no first-customer fact in ANY tool definition
// the worker registers; the location_id → location resolution table; the
// exact request bodies (`location` always present, `center` never); the old
// web's list-dates 400 reaching the model only as the neutral line; the
// inert `business` pass-through in the config fetcher.
// Run with:  npx tsx tests/booking-places.test.ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Mock web env only — no real host, no real secret.
process.env['APP_URL'] = 'http://web.invalid';
process.env['INTERNAL_SECRET'] = 'mock';

const { llm } = await import('@livekit/agents');
const { makeCalendarTools, resolveLocation, UNKNOWN_PLACE, NEUTRAL_REFUSAL } = await import('../tools/calendar.js');
const { makeOrdersTools } = await import('../tools/orders.js');
const { makeBusinessTools } = await import('../tools/business.js');
const { makeClientAgentTools } = await import('../tools/client-agent.js');
const { END_CALL_SPEC, TRANSFER_CALL_SPEC } = await import('../tools/call-control.js');
const { businessField, fetchConfig } = await import('../src/config-fetcher.js');

// Values copied from the web repo's scripts/tests/first-customer-facts.ts.
const FIRST_CUSTOMER_FACTS =
  /prestige|johana|j[ée]rusalem|ashdod|natanya|netanya|אשדוד|נתניה|ירושלים|\b\d+\s*(min|minutes|h|heures?|דקות)\b|soins?|épilation|lundi|mercredi|monday|wednesday/i;
const EXTRA_FACTS = /jerusalem|ashdod|natanya|épilation|soins? de la peau/i;

// ---- 1. no first-customer fact in any tool definition the worker registers ----

// Every source file that defines a tool must be one this test builds.
const COVERED = new Set(['agent.ts', 'tools/calendar.ts', 'tools/orders.ts', 'tools/business.ts', 'tools/client-agent.ts']);
const root = new URL('../', import.meta.url);
const sources = [
  'agent.ts',
  ...readdirSync(new URL('tools/', root)).filter((f) => f.endsWith('.ts')).map((f) => `tools/${f}`),
  ...readdirSync(new URL('src/', root), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/${f}`),
];
for (const f of sources) {
  if (readFileSync(new URL(f, root), 'utf8').includes('llm.tool(')) {
    assert.ok(COVERED.has(f), `${f} defines a tool this test does not cover`);
  }
}
// agent.ts's own tools take their definition from tools/call-control.ts.
const agentSrc = readFileSync(new URL('agent.ts', root), 'utf8');
const agentToolCalls = agentSrc.match(/llm\.tool\(\{\s*\n?\s*([^\n]*)/g) ?? [];
assert.equal(agentToolCalls.length, 2, 'agent.ts defines exactly end_call and transfer_call');
for (const c of agentToolCalls) assert.match(c, /\.\.\.(END_CALL_SPEC|TRANSFER_CALL_SPEC),/, `agent.ts tool not from a spec: ${c}`);
// The tool map agent.ts registers is made of exactly these sources.
const registration = agentSrc.slice(agentSrc.indexOf('const agent = new TenantAgent({'));
assert.match(
  registration,
  /tools: \{\s*\.\.\.calendarTools,\s*\.\.\.ordersTools,\s*\.\.\.businessTools,\s*end_call: endCallTool,\s*\.\.\.\(isPstnCall \? \{ transfer_call: transferCallTool \} : \{\}\),\s*\.\.\.clientAgentTools,\s*\}/,
  'agent.ts registers a tool map this test does not build',
);

// The real tool maps, every gated tool switched on.
type AnyTool = { description: string; parameters: unknown };
const allTools: Record<string, AnyTool> = {
  ...(makeCalendarTools({
    dialedPhone: '+15550000000',
    tenantUserId: '',
    features: { calendar: true, crm: true },
    places: [{ id: 'loc_a', name: 'Mock Place A' }],
  }) as unknown as Record<string, AnyTool>),
  ...(makeOrdersTools({ dialedPhone: '+15550000000', tenantUserId: '' }) as unknown as Record<string, AnyTool>),
  ...(makeBusinessTools({
    identity: { name: 'Mock Co', tagline: '', email: '' },
    centres: [{ id: 'loc_a', name: 'Mock Place A', address: 'Mock street', hours: {} }],
    services: [{ id: 'svc_1', name: 'Mock service', durationMinutes: 45, priceILS: 1, centreIds: 'all', description: '' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as unknown as Record<string, AnyTool>),
  ...(makeClientAgentTools({
    webhook: { url: 'https://agent.invalid/hook' },
    getCallId: () => 'call',
    getLanguage: () => 'en',
    getCallerSaid: () => '',
    getHistory: () => [],
  }) as unknown as Record<string, AnyTool>),
  end_call: END_CALL_SPEC,
  transfer_call: TRANSFER_CALL_SPEC,
};
assert.deepEqual(Object.keys(allTools).sort(), [
  'ask_client_agent',
  'book_appointment',
  'cancel_appointment',
  'check_availability',
  'end_call',
  'find_appointment',
  'find_service',
  'get_centre_info',
  'get_opening_hours',
  'list_available_dates',
  'list_centres',
  'list_services',
  'record_order',
  'reschedule_appointment',
  'save_contact',
  'transfer_call',
]);
for (const [name, tool] of Object.entries(allTools)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = JSON.stringify(llm.toJsonSchema(tool.parameters as any));
  for (const [what, text] of [
    ['name', name],
    ['description', tool.description],
    ['parameters', schema],
  ] as const) {
    assert.doesNotMatch(text, FIRST_CUSTOMER_FACTS, `${name} ${what} names a first-customer fact`);
    assert.doesNotMatch(text, EXTRA_FACTS, `${name} ${what} names a first-customer fact`);
  }
}
// No booking tool takes a `center` any more; the place-aware ones take location_id.
for (const name of ['list_available_dates', 'check_availability', 'book_appointment', 'reschedule_appointment']) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (llm.toJsonSchema(allTools[name]!.parameters as any) as { properties: Record<string, unknown> }).properties;
  assert.ok(!('center' in props), `${name} still takes center`);
  assert.ok('location_id' in props, `${name} takes location_id`);
}

// ---- 2. the resolution table ----

const ONE = [{ id: 'loc_a', name: 'Mock Place A' }];
const TWO = [...ONE, { id: 'loc_b', name: 'Mock Place B' }];
const ok = (location: string | null) => ({ ok: true, location });
const ask = { ok: false, message: UNKNOWN_PLACE };

// zero places
assert.deepEqual(resolveLocation([], undefined), ok(null));
assert.deepEqual(resolveLocation(undefined, null), ok(null));
assert.deepEqual(resolveLocation([], 'loc_x'), ok(null));
assert.deepEqual(resolveLocation([], undefined, { requireWhenSeveral: true }), ok(null));
// one place
assert.deepEqual(resolveLocation(ONE, undefined), ok('Mock Place A'));
assert.deepEqual(resolveLocation(ONE, 'loc_a'), ok('Mock Place A'));
assert.deepEqual(resolveLocation(ONE, 'loc_x'), ok('Mock Place A'));
assert.deepEqual(resolveLocation(ONE, undefined, { requireWhenSeveral: true }), ok('Mock Place A'));
// two places
assert.deepEqual(resolveLocation(TWO, 'loc_b'), ok('Mock Place B'));
assert.deepEqual(resolveLocation(TWO, ' mock place b '), ok('Mock Place B'), 'the exact name also resolves');
assert.deepEqual(resolveLocation(TWO, 'loc_x'), ask);
assert.deepEqual(resolveLocation(TWO, undefined), ok(null));
assert.deepEqual(resolveLocation(TWO, '  '), ok(null));
assert.deepEqual(resolveLocation(TWO, undefined, { requireWhenSeveral: true }), ask);
// entries without a usable name are ignored (partial payload)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
assert.deepEqual(resolveLocation([null, { id: 'x' }, ...ONE] as any, undefined), ok('Mock Place A'));

// ---- 3. the request bodies: `location` always, `center` never ----

let sent: Array<{ path: string; body: Record<string, unknown> }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body ?? '{}')) });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const realLog = console.log;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (tool: any, args: Record<string, unknown>): Promise<string> => {
  console.log = () => {};
  try {
    return await tool.execute(args, {});
  } finally {
    console.log = realLog;
  }
};
const toolsWith = (places: { id: string; name: string }[]) =>
  makeCalendarTools({
    dialedPhone: '+15550000000',
    tenantUserId: '',
    getCallerPhone: () => '0500000000',
    features: { calendar: true, crm: false },
    places,
  });

const CALLS = [
  ['list_available_dates', '/api/calendar/list-dates', { count: 3 }],
  ['check_availability', '/api/calendar/availability', { date: '2030-01-07', duration: 45 }],
  ['book_appointment', '/api/calendar/book', { name: 'Mock Client', date: '2030-01-07', time: '10:00', duration: 45 }],
  ['reschedule_appointment', '/api/calendar/reschedule', { event_id: 'evt_mock', new_date: '2030-01-08', new_time: '11:00' }],
] as const;

// The exact body shape: `location` present (string or null), `center` absent.
// The old web's lib/booking-place.ts isNewShape is `"location" in body`, so
// this shape takes its no-weekday-rule path on availability / book /
// reschedule too; no old-web route other than list-dates requires `center`.
const expectBody = (body: Record<string, unknown>, location: string | null, label: string) => {
  assert.ok('location' in body, `${label}: location key present`);
  assert.equal(body['location'], location, `${label}: location value`);
  assert.ok(!('center' in body), `${label}: center never sent`);
};

for (const [places, idArgs, expected, label] of [
  [[], {}, null, 'zero places, id omitted'],
  [ONE, {}, 'Mock Place A', 'one place, id omitted'],
  [ONE, { location_id: 'loc_a' }, 'Mock Place A', 'one place, known id'],
  [TWO, { location_id: 'loc_b' }, 'Mock Place B', 'two places, known id'],
] as const) {
  const tools = toolsWith([...places]);
  for (const [name, path, args] of CALLS) {
    sent = [];
    reply = { status: 200, body: { success: true, summary: 'ok', dates: [], available_slots: [] } };
    await run(tools[name], { ...args, ...idArgs });
    assert.equal(sent.length, 1, `${label} ${name}: one request`);
    assert.equal(sent[0]!.path, path);
    expectBody(sent[0]!.body, expected, `${label} ${name}`);
  }
}
// The full body of a booking with one known place.
sent = [];
await run(toolsWith(ONE).book_appointment, { ...CALLS[2][2], location_id: 'loc_a' });
assert.deepEqual(Object.keys(sent[0]!.body).sort(), ['date', 'duration', 'location', 'name', 'phone', 'time']);

// Two places, unknown id → the neutral ask, and no request at all.
{
  const tools = toolsWith(TWO);
  for (const [name, , args] of CALLS) {
    sent = [];
    assert.equal(await run(tools[name], { ...args, location_id: 'natanya' }), UNKNOWN_PLACE, `${name}: unknown id`);
    assert.equal(sent.length, 0, `${name}: nothing sent for an unknown id`);
  }
  // Two places, id omitted: booking asks; the others send location null.
  sent = [];
  assert.equal(await run(tools.book_appointment, CALLS[2][2]), UNKNOWN_PLACE);
  assert.equal(sent.length, 0);
  for (const [name, , args] of [CALLS[0], CALLS[1], CALLS[3]]) {
    sent = [];
    reply = { status: 200, body: { success: true, summary: 'ok', dates: [], available_slots: [] } };
    await run(tools[name], args);
    expectBody(sent[0]!.body, null, `two places, id omitted, ${name}`);
  }
}

// A reply in the location shape is spoken without any centre wording.
reply = { status: 200, body: { date: '2030-01-07', location: null, available_slots: ['10:00'] } };
assert.equal(await run(toolsWith([]).check_availability, { date: '2030-01-07' }), 'Le 2030-01-07, créneaux libres : 10:00');
reply = { status: 200, body: { date: '2030-01-07', location: 'Mock Place A', available_slots: ['10:00'] } };
assert.equal(await run(toolsWith(ONE).check_availability, { date: '2030-01-07' }), 'Le 2030-01-07 (Mock Place A), créneaux libres : 10:00');
reply = { status: 200, body: { location: null, dates: [{ date: '2030-01-07', weekday: 'mardi' }] } };
assert.equal(await run(toolsWith([]).list_available_dates, {}), 'Prochaines dates ouvertes : mardi 2030-01-07.');

// ---- 4. old web + new worker: list-dates refuses, the model hears the neutral line only ----

reply = { status: 400, body: { error: 'center invalide. Valeurs : jerusalem, ashdod, natanya', valid_centers: ['jerusalem', 'ashdod', 'natanya'] } };
for (const places of [[], ONE, TWO]) {
  const out = await run(toolsWith([...places]).list_available_dates, { count: 3 });
  assert.equal(out, NEUTRAL_REFUSAL);
  assert.doesNotMatch(out, EXTRA_FACTS);
}

// ---- 5. config: `business` copied only when it is an object with centres ----

assert.deepEqual(businessField(undefined), {});
assert.deepEqual(businessField(null), {});
assert.deepEqual(businessField('x'), {});
assert.deepEqual(businessField([]), {});
assert.deepEqual(businessField({}), {});
assert.deepEqual(businessField({ centres: 'x' }), {});
const BUSINESS = { identity: { name: 'Mock Co', tagline: '', email: '' }, centres: ONE, services: [] };
assert.deepEqual(businessField(BUSINESS), { business: BUSINESS });

// fetchConfig: without `business` the cfg is exactly what it was (no key),
// and the business tools stay unregistered.
const PAYLOAD = { instructions: 'Mock instructions', greetingInstructions: '', features: { calendar: true, crm: true } };
const configReply = (body: unknown) => {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/api/vox')) return new Response('{}', { status: 404 });
    if (path === '/api/events') return new Response('{"ok":true}', { status: 200 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
};
const SIP = { kind: 'sip', calledNumber: '+15550000000', channel: 'pstn' } as const;
configReply(PAYLOAD);
const today = await fetchConfig(SIP);
assert.ok(!('business' in today), 'absent business → no key');
assert.deepEqual(makeBusinessTools(today.business), {});
configReply({ ...PAYLOAD, business: { centres: 'not an array' } });
assert.deepEqual(await fetchConfig(SIP), today, 'a malformed business changes nothing');
configReply({ ...PAYLOAD, business: BUSINESS });
assert.deepEqual(await fetchConfig(SIP), { ...today, business: BUSINESS });

console.log('ALL BOOKING-PLACES TESTS PASSED');
process.exit(0);
