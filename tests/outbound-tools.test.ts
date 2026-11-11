// Tools on outbound calls (T4c): campaign / outbound_test calls get booking
// and transfer ONLY when the web turned them on, routed by the account id —
// never by a call number. Inbound calls are unchanged.
// Run with:  npx tsx tests/outbound-tools.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env['APP_URL'] = 'http://web.test';
process.env['INTERNAL_SECRET'] = 'mock';

const { planCallTools, tenantRoutingHeaders } = await import('../src/call-tools.js');
const { makeCalendarTools } = await import('../tools/calendar.js');
const { makeOrdersTools } = await import('../tools/orders.js');
const { transferEligible } = await import('../src/transfer.js');

type Origin = Parameters<typeof planCallTools>[0];
const campaign: Origin = { kind: 'campaign', campaignId: 'c1', contactId: 'k1', userId: '' };
const outboundTest: Origin = { kind: 'outbound_test', agentId: 'a1', userId: 'u-test' };
const sipIn: Origin = { kind: 'sip', calledNumber: '+15550000100', channel: 'pstn' };
const webIn: Origin = { kind: 'web', userId: 'u-web' };
const OFF = { calendar: false, crm: false, whatsapp_confirm: false, whatsapp_recap: false };
const ACCOUNT = 'acct-0001';
const TRUNK_DEFAULT = '+15550000999'; // the trunk's default caller id (maybe another account's)

// Mocked fetch: record every request's path + headers.
const sent: Array<{ path: string; headers: Record<string, string> }> = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const h = new Headers(init?.headers);
  const headers: Record<string, string> = {};
  h.forEach((v, k) => (headers[k] = v));
  sent.push({ path: new URL(url).pathname, headers });
  const path = new URL(url).pathname;
  const reply =
    path === '/api/calendar/availability'
      ? { date: '2030-01-07', location: null, available_slots: ['10:00'] }
      : { success: true, summary: 'ok', ok: true };
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

type Exec = { execute: (args: Record<string, unknown>, opts: unknown) => Promise<unknown> };
const run = (tool: unknown, args: Record<string, unknown>) =>
  (tool as Exec).execute(args, { ctx: {}, toolCallId: 't', abortSignal: undefined });

const CALENDAR_TOOLS = ['book_appointment', 'cancel_appointment', 'check_availability', 'find_appointment', 'reschedule_appointment'];

// Builds the calendar tools exactly as agent.ts does, for one origin + payload.
const buildFor = (origin: Origin, cfg: Parameters<typeof planCallTools>[1], dialed: string, webUserId = '') => {
  const plan = planCallTools(origin, cfg);
  const tools = makeCalendarTools({
    dialedPhone: dialed,
    getDialedPhone: () => dialed,
    tenantUserId: webUserId,
    ...(plan.outboundAccountId ? { outboundAccountId: plan.outboundAccountId } : {}),
    features: plan.calendarFeatures,
  });
  return { plan, tools };
};

// 1. Campaign with calendar + accountId: calendar tools present; every request
//    carries x-tenant-user-id + x-call-direction and NO x-tenant-phone, even
//    though a dialed number (our trunk caller id) exists.
{
  const { plan, tools } = buildFor(campaign, { features: { ...OFF, calendar: true }, accountId: ACCOUNT }, TRUNK_DEFAULT);
  assert.deepEqual(Object.keys(tools).sort(), CALENDAR_TOOLS);
  assert.equal(plan.error, undefined);
  sent.length = 0;
  const t = tools as Record<string, unknown>;
  await run(t['check_availability'], { date: '2030-01-07' });
  await run(t['book_appointment'], { name: 'Dana', phone: '+15550000001', date: '2030-01-07', time: '10:00' });
  await run(t['find_appointment'], { phone: '+15550000001' });
  await run(t['cancel_appointment'], { event_id: 'e1' });
  await run(t['reschedule_appointment'], { event_id: 'e1', new_date: '2030-01-08', new_time: '11:00' });
  assert.ok(sent.length >= 5, `expected 5+ requests, got ${sent.length}`);
  for (const r of sent) {
    assert.equal(r.headers['x-tenant-user-id'], ACCOUNT, `${r.path} routes by the account id`);
    assert.equal(r.headers['x-call-direction'], 'outbound', `${r.path} says outbound`);
    assert.ok(!('x-tenant-phone' in r.headers), `${r.path} must not send x-tenant-phone`);
  }
}

// 1b. Same for outbound_test (a web room): routed by accountId, no transfer.
{
  const { plan, tools } = buildFor(outboundTest, { features: { ...OFF, calendar: true }, accountId: ACCOUNT, transferNumber: '+15550000200' }, '', 'u-test');
  assert.deepEqual(Object.keys(tools).sort(), CALENDAR_TOOLS);
  assert.equal(plan.transfer, false, 'no transfer on an outbound test (web room)');
  sent.length = 0;
  await run((tools as Record<string, unknown>)['check_availability'], { date: '2030-01-07' });
  assert.equal(sent[0]?.headers['x-tenant-user-id'], ACCOUNT);
  assert.equal(sent[0]?.headers['x-call-direction'], 'outbound');
}

// 2. Campaign with calendar but no accountId: no calendar tool, error reported.
for (const accountId of [undefined, '', '   ']) {
  const { plan, tools } = buildFor(campaign, { features: { ...OFF, calendar: true }, ...(accountId !== undefined ? { accountId } : {}) }, TRUNK_DEFAULT);
  assert.deepEqual(Object.keys(tools), [], 'fail closed without accountId');
  assert.equal(plan.error?.event, 'outbound_tools_no_account');
  assert.equal(plan.outboundAccountId, undefined);
}

// 3. Transfer: campaign with a transfer number → transfer_call; without → not.
assert.equal(planCallTools(campaign, { features: OFF, accountId: ACCOUNT, transferNumber: '+15550000200' }).transfer, true);
assert.equal(planCallTools(campaign, { features: OFF }).transfer, false);
assert.equal(planCallTools(campaign, { features: OFF, transferNumber: '' }).transfer, false);
assert.equal(planCallTools(outboundTest, { features: OFF, transferNumber: '+15550000200' }).transfer, false);
// ... and the tool can actually transfer that leg (same E.164 rule as inbound).
assert.equal(transferEligible({ originKind: 'campaign', transferNumber: '+15550000200' }), true);
assert.equal(transferEligible({ originKind: 'campaign', transferNumber: '0550000000' }), false);
assert.equal(transferEligible({ originKind: 'outbound_test', transferNumber: '+15550000200' }), false);

// 4. Off payload (today's): outbound gets exactly today's tool set — no
//    calendar, no CRM, no orders, no transfer (end_call only, added by agent.ts).
for (const origin of [campaign, outboundTest]) {
  const off = planCallTools(origin, { features: OFF });
  assert.deepEqual(off, { calendarFeatures: { calendar: false, crm: false }, orders: false, transfer: false });
  const { tools } = buildFor(origin, { features: OFF }, TRUNK_DEFAULT);
  assert.deepEqual(Object.keys(tools), []);
}
// Orders stay off on outbound even if a payload says otherwise.
assert.equal(planCallTools(campaign, { features: OFF, ordersEnabled: true, accountId: ACCOUNT }).orders, false);

// 5. Inbound unchanged: SIP routes by x-tenant-phone (live dialed number), web
//    by x-tenant-user-id; historical feature/orders/transfer rules.
{
  const { plan, tools } = buildFor(sipIn, { features: { calendar: true, crm: false } }, '+15550000100');
  assert.equal(plan.outboundAccountId, undefined);
  sent.length = 0;
  await run((tools as Record<string, unknown>)['check_availability'], { date: '2030-01-07' });
  const h = sent[0]!.headers;
  assert.equal(h['x-tenant-phone'], '+15550000100');
  assert.ok(!('x-tenant-user-id' in h) && !('x-call-direction' in h));
}
{
  const { tools } = buildFor(webIn, { features: { calendar: true, crm: false } }, '', 'u-web');
  sent.length = 0;
  await run((tools as Record<string, unknown>)['check_availability'], { date: '2030-01-07' });
  const h = sent[0]!.headers;
  assert.equal(h['x-tenant-user-id'], 'u-web');
  assert.ok(!('x-tenant-phone' in h) && !('x-call-direction' in h));
}
// Inbound ignores accountId and keeps the "absent feature = on" legacy rule.
assert.deepEqual(planCallTools(sipIn, { features: {}, ordersEnabled: true, accountId: ACCOUNT, transferNumber: '+15550000200' }), {
  calendarFeatures: { calendar: true, crm: true },
  orders: true,
  transfer: true,
});
assert.equal(planCallTools({ kind: 'sip', calledNumber: '+15550000100', channel: 'whatsapp' }, { features: {} }).transfer, false);
assert.equal(planCallTools(webIn, { features: {} }).transfer, false);
assert.deepEqual(tenantRoutingHeaders({ dialedPhone: '', getDialedPhone: () => '+15550000100', tenantUserId: 'u' }), { 'x-tenant-phone': '+15550000100' });
assert.deepEqual(tenantRoutingHeaders({ dialedPhone: '', tenantUserId: '' }), {});

// 6. Orders tool shares the routing (inbound SIP → x-tenant-phone).
{
  const { record_order } = makeOrdersTools({ dialedPhone: '+15550000100', tenantUserId: '' });
  sent.length = 0;
  await run(record_order, { item: 'x' });
  assert.equal(sent[0]!.headers['x-tenant-phone'], '+15550000100');
}

// 7. agent.ts wires the plan (not the raw flags) into the registered tools.
const agentSrc = readFileSync(new URL('../agent.ts', import.meta.url), 'utf8');
assert.match(agentSrc, /const toolPlan = planCallTools\(origin, cfg\)/);
assert.match(agentSrc, /features: toolPlan\.calendarFeatures/);
assert.match(agentSrc, /toolPlan\.transfer \? \{ transfer_call: transferCallTool \}/);
assert.match(agentSrc, /const ordersTools = toolPlan\.orders/);
assert.doesNotMatch(agentSrc, /isPstnCall \?/);

console.log('ALL OUTBOUND-TOOLS TESTS PASSED');
process.exit(0);
