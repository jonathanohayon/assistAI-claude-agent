import assert from 'node:assert/strict';

// Mock web env only — no real host, no real secret.
process.env['APP_URL'] = 'http://web.invalid';
process.env['INTERNAL_SECRET'] = 'test-secret';

const { formatToolCall, scrubToolArgs, looksLikePhone, looksLikeEmail, TOOL_LOG_ALLOWLIST } =
  await import('../src/tool-log.js');
const { makeCalendarTools, formatListDates } = await import('../tools/calendar.js');
const { makeOrdersTools } = await import('../tools/orders.js');
const { makeBusinessTools } = await import('../tools/business.js');

// Personal values used in mock calls: none of them may ever appear in a [tool] line.
const PERSONAL = [
  'Dana Levi',
  '0521234567',
  '+972521234567',
  'dana@example.com',
  'soin du visage',
  'rappelle-moi demain',
  'massage',
  'gâteau au chocolat',
  '12 rue Herzl',
];

// ---- helper: allowlist, scrubbing, unknown keys ----

// unknown keys are dropped
assert.deepEqual(scrubToolArgs({ date: '2026-11-24', foo: 'bar' }, ['date']), { date: '2026-11-24' });
// non-allowlisted personal keys are dropped
assert.deepEqual(
  scrubToolArgs({ name: 'Dana Levi', phone: '0521234567', date: '2026-11-24' }, ['date']),
  { date: '2026-11-24' },
);
// phone-looking value dropped even under an allowlisted key
assert.deepEqual(scrubToolArgs({ center: '+972 52-123-4567' }, ['center']), {});
assert.deepEqual(scrubToolArgs({ center: '0521234567' }, ['center']), {});
assert.deepEqual(scrubToolArgs({ count: 521234567 }, ['count']), {});
// email-looking value dropped even under an allowlisted key
assert.deepEqual(scrubToolArgs({ centreId: 'dana@example.com' }, ['centreId']), {});
// free text (spaces) dropped even under an allowlisted key
assert.deepEqual(scrubToolArgs({ center: 'near my house please' }, ['center']), {});
// dates, times, ids, numbers, booleans, null are handled
assert.deepEqual(
  scrubToolArgs(
    { date: '2026-11-24', time: '10:00', event_id: 'evt_abc123', duration: 60, flag: true, center: null },
    ['date', 'time', 'event_id', 'duration', 'flag', 'center'],
  ),
  { date: '2026-11-24', time: '10:00', event_id: 'evt_abc123', duration: 60, flag: true },
);
// enum-constrained keys keep only known values
assert.deepEqual(scrubToolArgs({ reason: 'voicemail' }, [{ key: 'reason', oneOf: ['voicemail'] }]), {
  reason: 'voicemail',
});
assert.deepEqual(scrubToolArgs({ reason: 'she_is_angry' }, [{ key: 'reason', oneOf: ['voicemail'] }]), {});
// dates and times are not phones
assert.equal(looksLikePhone('2026-11-24'), false);
assert.equal(looksLikePhone('10:30'), false);
assert.equal(looksLikePhone('052-123-4567'), true);
assert.equal(looksLikeEmail('a@b.co'), true);
// non-object args, unknown tool
assert.deepEqual(scrubToolArgs(null, ['date']), {});
assert.equal(formatToolCall('not_a_tool', { date: '2026-11-24' }), '[tool] not_a_tool args={}');

// ---- each tool logs exactly one [tool] line on a mock call ----

let fetchBodies: unknown[] = [];
let nextResponse: unknown = {};
globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
  fetchBodies.push(init?.body ? JSON.parse(init.body) : null);
  return new Response(JSON.stringify(nextResponse), { status: 200 });
}) as typeof fetch;

const realLog = console.log;
const realError = console.error;
let lines: string[] = [];
const capture = async (fn: () => Promise<unknown>): Promise<string[]> => {
  lines = [];
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines.filter((l) => l.startsWith('[tool] '));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, args: unknown) => tool.execute(args, {});

const assertOneLine = (toolLines: string[], name: string, expected: Record<string, unknown>) => {
  assert.equal(toolLines.length, 1, `${name}: expected one [tool] line, got ${toolLines.length}`);
  assert.equal(toolLines[0], `[tool] ${name} args=${JSON.stringify(expected)}`);
  for (const p of PERSONAL) assert.ok(!toolLines[0]!.includes(p), `${name} leaked "${p}"`);
  // every name we test must have an explicit allowlist entry
  assert.ok(name in TOOL_LOG_ALLOWLIST, `${name} has no allowlist entry`);
};

const cal = makeCalendarTools({
  dialedPhone: '+15550000000',
  tenantUserId: '',
  getCallerPhone: () => '0521234567',
  places: [{ id: 'loc_1', name: 'Mock Place' }],
});

nextResponse = { center: 'jerusalem', label: 'Jérusalem', dates: [] };
assertOneLine(
  await capture(() => run(cal.list_available_dates, { location_id: 'loc_1', count: 3, after: '2026-11-24' })),
  'list_available_dates',
  { location_id: 'loc_1', count: 3, after: '2026-11-24' },
);

nextResponse = { date: '2026-11-24', label: 'Jérusalem', available_slots: ['10:00'] };
assertOneLine(
  await capture(() => run(cal.check_availability, { date: '2026-11-24', location_id: 'loc_1', duration: 60 })),
  'check_availability',
  { date: '2026-11-24', location_id: 'loc_1', duration: 60 },
);

nextResponse = { success: true, summary: 'ok' };
fetchBodies = [];
assertOneLine(
  await capture(() =>
    run(cal.book_appointment, {
      name: 'Dana Levi',
      phone: '+972521234567',
      date: '2026-11-24',
      time: '10:00',
      location_id: 'loc_1',
      description: 'soin du visage',
      email: 'dana@example.com',
      duration: 60,
    }),
  ),
  'book_appointment',
  { date: '2026-11-24', time: '10:00', location_id: 'loc_1', duration: 60 },
);
// the log line is written before the HTTP call (the call itself still happens)
assert.ok(fetchBodies.length >= 1);

nextResponse = { message: 'ok' };
assertOneLine(
  await capture(() =>
    run(cal.save_contact, { name: 'Dana Levi', phone: '0521234567', email: 'dana@example.com', notes: 'rappelle-moi demain' }),
  ),
  'save_contact',
  {},
);

nextResponse = { events: [] };
assertOneLine(
  await capture(() => run(cal.find_appointment, { phone: '0521234567', date: '2026-11-24' })),
  'find_appointment',
  { date: '2026-11-24' },
);

nextResponse = { message: 'ok' };
assertOneLine(
  await capture(() => run(cal.cancel_appointment, { event_id: 'evt_abc123' })),
  'cancel_appointment',
  { event_id: 'evt_abc123' },
);

nextResponse = { summary: 'ok' };
assertOneLine(
  await capture(() =>
    run(cal.reschedule_appointment, {
      event_id: 'evt_abc123',
      new_date: '2026-11-25',
      new_time: '11:30',
      location_id: 'loc_1',
      duration: 30,
    }),
  ),
  'reschedule_appointment',
  { event_id: 'evt_abc123', new_date: '2026-11-25', new_time: '11:30', location_id: 'loc_1', duration: 30 },
);

const orders = makeOrdersTools({ dialedPhone: '+15550000000', tenantUserId: '', getCallerPhone: () => '0521234567' });
nextResponse = {};
assertOneLine(
  await capture(() =>
    run(orders.record_order, {
      item: 'gâteau au chocolat',
      quantity: 2,
      description: 'rappelle-moi demain',
      name: 'Dana Levi',
      center: 'ashdod',
    }),
  ),
  'record_order',
  { quantity: 2, center: 'ashdod' },
);

const business = makeBusinessTools({
  identity: { name: 'Mock', tagline: '', email: '' },
  centres: [{ id: 'ctr_1', name: 'Jerusalem', address: '12 rue Herzl', hours: {} }],
  services: [{ id: 'svc_1', name: 'massage', durationMinutes: 60, priceILS: 100, centreIds: 'all' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);
assertOneLine(await capture(() => run(business['list_centres'], {})), 'list_centres', {});
assertOneLine(
  await capture(() => run(business['get_centre_info'], { centreId: 'ctr_1' })),
  'get_centre_info',
  { centreId: 'ctr_1' },
);
assertOneLine(
  await capture(() => run(business['get_opening_hours'], { centreId: 'ctr_1', day: 'mon', isoDate: '2026-11-23' })),
  'get_opening_hours',
  { centreId: 'ctr_1', day: 'mon', isoDate: '2026-11-23' },
);
assertOneLine(
  await capture(() => run(business['list_services'], { centreId: 'ctr_1' })),
  'list_services',
  { centreId: 'ctr_1' },
);
assertOneLine(
  await capture(() => run(business['find_service'], { query: 'massage', centreId: 'ctr_1' })),
  'find_service',
  { centreId: 'ctr_1' },
);

// end_call / transfer_call live inside agent.ts's entry closure; their execute
// calls logToolCall(name, { reason }) — the line it produces is checked here.
assert.equal(formatToolCall('end_call', { reason: 'appointment_booked' }), '[tool] end_call args={"reason":"appointment_booked"}');
assert.equal(formatToolCall('end_call', { reason: 'Dana Levi a dit au revoir' }), '[tool] end_call args={}');
assert.equal(formatToolCall('transfer_call', { reason: 'urgent' }), '[tool] transfer_call args={"reason":"urgent"}');
assert.equal(formatToolCall('transfer_call', { reason: 'she wants to complain about Dana' }), '[tool] transfer_call args={}');

// every registered calendar / orders / business tool has an allowlist entry
for (const name of [...Object.keys(cal), ...Object.keys(orders), ...Object.keys(business), 'end_call', 'transfer_call']) {
  assert.ok(name in TOOL_LOG_ALLOWLIST, `${name} has no allowlist entry`);
}

// ---- list_available_dates output with and without requested_date_open ----

const base = { center: 'jerusalem', label: 'Jérusalem', dates: [{ date: '2026-11-24', weekday: 'mardi' }] };
// old web (no new keys): exactly today's text
assert.equal(formatListDates(base), 'Prochaines dates ouvertes à Jérusalem : mardi 2026-11-24.');
assert.equal(formatListDates({ ...base, dates: [] }), 'Aucune date trouvée pour Jérusalem.');
assert.equal(formatListDates({ ...base, error: 'boom' }), 'Erreur : boom');
// new web, asked date open
assert.equal(
  formatListDates({ ...base, requested_date: '2026-11-24', requested_date_open: true }),
  'Le 2026-11-24 est ouvert à Jérusalem. Prochaines dates ouvertes à Jérusalem : mardi 2026-11-24.',
);
// new web, asked date not open
assert.equal(
  formatListDates({
    ...base,
    dates: [{ date: '2026-11-25', weekday: 'mercredi' }],
    requested_date: '2026-11-23',
    requested_date_open: false,
  }),
  "Le 2026-11-23 n'est pas ouvert à Jérusalem. Prochaines dates ouvertes à Jérusalem : mercredi 2026-11-25.",
);
// flag without a date: fall back to today's text
assert.equal(formatListDates({ ...base, requested_date_open: true }), 'Prochaines dates ouvertes à Jérusalem : mardi 2026-11-24.');

// the tool returns that text end to end
nextResponse = { ...base, requested_date: '2026-11-24', requested_date_open: true };
let out = '';
await capture(async () => {
  out = await run(cal.list_available_dates, { after: '2026-11-24' });
});
assert.equal(out, 'Le 2026-11-24 est ouvert à Jérusalem. Prochaines dates ouvertes à Jérusalem : mardi 2026-11-24.');
nextResponse = base;
await capture(async () => {
  out = await run(cal.list_available_dates, {});
});
assert.equal(out, 'Prochaines dates ouvertes à Jérusalem : mardi 2026-11-24.');

console.log('ALL TOOL-LOG TESTS PASSED');
