import assert from 'node:assert/strict';

// Mock web env only — no real host, no real secret.
process.env['APP_URL'] = 'http://web.invalid';
process.env['INTERNAL_SECRET'] = 'test-secret';

const { makeCalendarTools, parseReasoned4xx, formatRefusal, NEUTRAL_REFUSAL, SPEAKABLE_REFUSALS } = await import(
  '../tools/calendar.js'
);

// ---- mocked fetch: every call answers with the next (status, body) ----

let nextStatus = 200;
let nextBody = '{}';
const urls: string[] = [];
globalThis.fetch = (async (url: string) => {
  urls.push(url);
  return new Response(nextBody, { status: nextStatus });
}) as typeof fetch;
const answer = (status: number, body: unknown) => {
  nextStatus = status;
  nextBody = typeof body === 'string' ? body : JSON.stringify(body);
};

const realLog = console.log;
const realError = console.error;
let logs: string[] = [];
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    return await fn();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, args: unknown) => quiet(() => tool.execute(args, {}) as Promise<string>);

const cal = makeCalendarTools({
  dialedPhone: '+15550000000',
  tenantUserId: '',
  getCallerPhone: () => '+15550000001',
});

const BOOK_ARGS = { name: 'Mock Client', date: '2026-12-01', time: '10:00', duration: 30 };
const RESCHEDULE_ARGS = { event_id: 'evt_mock1', new_date: '2026-12-01', new_time: '10:00' };

const WRONG_DAY = {
  error: 'wrong_day_for_center',
  message: 'Ashdod est ouvert le lundi uniquement.',
  expectedCenter: 'jerusalem',
  expectedLabel: 'Jérusalem',
  suggested_dates: [
    { date: '2026-12-07', weekday: 'lundi' },
    { date: '2026-12-14', weekday: 'lundi' },
  ],
};

// ---- helper: which bodies are handed back ----

assert.deepEqual(parseReasoned4xx(400, JSON.stringify({ error: 'x' })), { error: 'x' });
assert.deepEqual(parseReasoned4xx(409, JSON.stringify({ error: 'slot_conflict', message: 'm' })), {
  error: 'slot_conflict',
  message: 'm',
});
assert.equal(parseReasoned4xx(401, JSON.stringify({ error: 'unauthorized' })), null);
assert.equal(parseReasoned4xx(500, JSON.stringify({ error: 'boom' })), null);
assert.equal(parseReasoned4xx(502, JSON.stringify({ error: 'boom' })), null);
assert.equal(parseReasoned4xx(400, '<html>Bad Request</html>'), null);
assert.equal(parseReasoned4xx(400, JSON.stringify({ message: 'no error field' })), null);
assert.equal(parseReasoned4xx(400, JSON.stringify({ error: 42 })), null);
assert.equal(parseReasoned4xx(400, JSON.stringify(['error'])), null);
assert.equal(parseReasoned4xx(400, 'null'), null);
assert.equal(formatRefusal({ error: 'code', message: 'Le message.' }), 'Impossible : Le message.');
assert.equal(formatRefusal({ error: 'code' }), 'Impossible : code');
assert.equal(formatRefusal({ error: 'code', message: 7 }), 'Impossible : code');
assert.equal(formatRefusal({ error: 'x'.repeat(500) }).length, 'Impossible : '.length + 200);

// ---- book on the wrong centre's day: 400 wrong_day_for_center → suggested dates ----

answer(400, WRONG_DAY);
{
  const out = await run(cal.book_appointment, BOOK_ARGS);
  assert.equal(
    out,
    'Ashdod est ouvert le lundi uniquement. Propose plutôt : lundi 2026-12-07, lundi 2026-12-14.',
  );
  assert.ok(logs.some((l) => l.startsWith('[calendar-latency] /api/calendar/book → 400 ')));
  // the auto-save to the CRM only runs on a successful booking
  assert.ok(!urls.some((u) => u.endsWith('/api/sheets/contact')));
}

// ---- reschedule on the wrong centre's day: same branch ----

answer(400, WRONG_DAY);
assert.equal(
  await run(cal.reschedule_appointment, RESCHEDULE_ARGS),
  'Ashdod est ouvert le lundi uniquement. Propose plutôt : lundi 2026-12-07, lundi 2026-12-14.',
);

// ---- slot_conflict (409) → the existing branch text ----

const CONFLICT = {
  error: 'slot_conflict',
  message: 'Le créneau 10:00 (30 min) chevauche un rendez-vous existant le 2026-12-01. Créneaux libres : 11:00, 12:00.',
  available_slots: ['11:00', '12:00'],
};
answer(409, CONFLICT);
assert.equal(await run(cal.book_appointment, BOOK_ARGS), CONFLICT.message);
answer(409, CONFLICT);
assert.equal(await run(cal.reschedule_appointment, RESCHEDULE_ARGS), CONFLICT.message);
answer(409, { error: 'slot_conflict' });
assert.equal(
  await run(cal.book_appointment, BOOK_ARGS),
  'Ce créneau chevauche un rendez-vous existant. Propose une autre heure.',
);

// ---- "date invalide" 400 → a neutral text with the reason, in every tool ----

const INVALID = { error: 'Date/heure invalide : 2026-13-01 10:00' };
answer(400, INVALID);
assert.equal(await run(cal.book_appointment, BOOK_ARGS), `Impossible : ${INVALID.error}`);
answer(400, INVALID);
assert.equal(await run(cal.reschedule_appointment, RESCHEDULE_ARGS), `Impossible : ${INVALID.error}`);
// ---- refusals the caller cannot act on → exactly the neutral text ----

const NEUTRAL = 'Impossible pour le moment.';
assert.equal(NEUTRAL_REFUSAL, NEUTRAL);

answer(400, { error: 'date requise (YYYY-MM-DD)' });
assert.equal(await run(cal.check_availability, { date: '', duration: 30 }), NEUTRAL);
answer(400, { error: 'center invalide. Valeurs : jerusalem, ashdod, natanya' });
assert.equal(await run(cal.list_available_dates, {}), NEUTRAL);
answer(400, { error: 'Téléphone requis' });
assert.equal(await run(cal.find_appointment, { phone: '' }), NEUTRAL);
answer(400, { error: 'eventId requis' });
assert.equal(await run(cal.cancel_appointment, { event_id: '' }), NEUTRAL);
answer(400, { error: 'Nom et téléphone requis' });
assert.equal(await run(cal.save_contact, { name: 'Mock Client' }), NEUTRAL);
answer(400, { error: 'some_code', message: 'Une raison lisible.' });
assert.equal(await run(cal.cancel_appointment, { event_id: 'evt_mock1' }), NEUTRAL);

// a 404 for an unknown tenant: neutral to the model, code-only log (no digits of the number)
for (const [tool, args] of [
  [cal.book_appointment, BOOK_ARGS],
  [cal.reschedule_appointment, RESCHEDULE_ARGS],
  [cal.find_appointment, { phone: '+15550000002' }],
  [cal.cancel_appointment, { event_id: 'evt_mock1' }],
  [cal.check_availability, { date: '2026-12-01' }],
  [cal.list_available_dates, {}],
] as const) {
  answer(404, { error: 'Tenant inconnu pour +15550000001' });
  assert.equal(await run(tool, args), NEUTRAL);
  assert.ok(logs.some((l) => /^\[calendar\] refused 404 tenant_unknown$/.test(l)), logs.join('\n'));
  for (const l of logs) assert.ok(!l.includes('5550000001') && !l.includes('Tenant inconnu'), `leak: ${l}`);
}

// a 409 "Google Calendar not connected" → neutral, logged by code
answer(409, { error: 'Google Calendar non connecté pour ce compte.' });
assert.equal(await run(cal.find_appointment, { phone: '+15550000001' }), NEUTRAL);
assert.ok(logs.includes('[calendar] refused 409 calendar_not_connected'));
answer(409, { error: 'Google Calendar non connecté pour ce compte.' });
assert.equal(await run(cal.book_appointment, BOOK_ARGS), NEUTRAL);

// an unknown 400 code can never be spoken (random codes, every tool)
const ALL_TOOLS = [
  [cal.book_appointment, BOOK_ARGS],
  [cal.reschedule_appointment, RESCHEDULE_ARGS],
  [cal.find_appointment, { phone: '+15550000001' }],
  [cal.cancel_appointment, { event_id: 'evt_mock1' }],
  [cal.check_availability, { date: '2026-12-01' }],
  [cal.list_available_dates, {}],
  [cal.save_contact, { name: 'Mock Client' }],
] as const;
for (let i = 0; i < 20; i++) {
  const code = `zz_${Math.random().toString(36).slice(2, 10)}`;
  for (const [tool, args] of ALL_TOOLS) {
    answer(400, { error: code, message: `secret wording ${code}` });
    assert.equal(await run(tool, args), NEUTRAL, code);
  }
}
answer(400, { error: 'unknown_internal_code' });
assert.equal(await run(cal.book_appointment, BOOK_ARGS), NEUTRAL);
assert.ok(logs.includes('[calendar] refused 400 unknown_internal_code'));

// the allowlist is exactly the actionable refusals
assert.deepEqual(
  SPEAKABLE_REFUSALS.map((r) => r.name),
  ['wrong_day_for_center', 'slot_conflict', 'invalid_date', 'invalid_datetime', 'past_slot', 'invalid_time', 'invalid_duration'],
);

// the web's invalid time / duration wordings (lib/booking-request) reach the model verbatim: it can retry
const BAD_TIME = 'Heure invalide : 25:00 (format attendu HH:MM, 00:00–23:59)';
const BAD_DURATION = 'Durée invalide : 1000 (minutes, entier entre 5 et 480)';
for (const [tool, args] of [
  [cal.book_appointment, BOOK_ARGS],
  [cal.reschedule_appointment, RESCHEDULE_ARGS],
] as const) {
  answer(400, { error: BAD_TIME });
  assert.equal(await run(tool, args), `Impossible : ${BAD_TIME}`);
  assert.ok(logs.includes('[calendar] refused 400 invalid_time'), logs.join('\n'));
  answer(400, { error: BAD_DURATION });
  assert.equal(await run(tool, args), `Impossible : ${BAD_DURATION}`);
  assert.ok(logs.includes('[calendar] refused 400 invalid_duration'), logs.join('\n'));
  // allowlisted but carrying a 7+ digit run → still neutral
  answer(400, { error: 'Heure invalide : 15550000001 (format attendu HH:MM, 00:00–23:59)' });
  assert.equal(await run(tool, args), NEUTRAL);
  answer(400, { error: 'Durée invalide : 15550000001 (minutes, entier entre 5 et 480)' });
  assert.equal(await run(tool, args), NEUTRAL);
  // the other book-side refusal stays neutral
  answer(400, { error: 'Champs requis manquants (name, phone, date, time)' });
  assert.equal(await run(tool, args), NEUTRAL);
  // anchored: the wording must start the message
  answer(400, { error: 'Erreur : Heure invalide : 25:00' });
  assert.equal(await run(tool, args), NEUTRAL);
}

// the web's own invalid / past date wordings stay verbatim
answer(400, { error: 'date invalide : 2026-02-30 (YYYY-MM-DD attendu)' });
assert.equal(
  await run(cal.find_appointment, { phone: '+15550000001' }),
  'Impossible : date invalide : 2026-02-30 (YYYY-MM-DD attendu)',
);
answer(400, { error: 'Date invalide : 2026-2-3 (format attendu YYYY-MM-DD)' });
assert.equal(
  await run(cal.book_appointment, BOOK_ARGS),
  'Impossible : Date invalide : 2026-2-3 (format attendu YYYY-MM-DD)',
);
answer(400, { error: 'date invalide : 2026-02-30 (YYYY-MM-DD attendu)' });
assert.equal(
  await run(cal.list_available_dates, {}),
  'Erreur : date invalide : 2026-02-30 (YYYY-MM-DD attendu)',
);
const PAST = 'Le créneau 2026-01-05 10:00 est déjà passé. Propose un horaire futur.';
answer(400, { error: PAST });
assert.equal(await run(cal.reschedule_appointment, RESCHEDULE_ARGS), `Impossible : ${PAST}`);
assert.ok(logs.includes('[calendar] refused 400 past_slot'));

// ---- property: no 7+ digit run ever reaches the model, on any refusal path ----

const DIGITS = /\d{7,}/;
const NUMBERS = ['+15550000001', '15550000001', '5550000', '0000000'];
const bodies = (n: string): unknown[] => [
  { error: `Tenant inconnu pour ${n}` },
  { error: `Google Calendar non connecté pour ${n}` },
  { error: `date invalide : ${n} (YYYY-MM-DD attendu)` },
  { error: `Date/heure invalide : ${n} 10:00` },
  { error: `Le créneau ${n} 10:00 est déjà passé.` },
  { error: `Heure invalide : ${n} (format attendu HH:MM, 00:00–23:59)` },
  { error: `Durée invalide : ${n} (minutes, entier entre 5 et 480)` },
  { error: 'slot_conflict', message: `Le créneau chevauche ; rappeler le ${n}.` },
  { error: 'slot_conflict', message: 'm', available_slots: [n] },
  { error: 'wrong_day_for_center', message: `Ouvert le lundi, contact ${n}.`, suggested_dates: [] },
  { ...WRONG_DAY, suggested_dates: [{ date: n, weekday: 'lundi' }] },
  { error: 'wrong_day_for_center', message: 'm', expectedLabel: n },
  { error: n },
  { error: 'some_code', message: n },
];
for (const n of NUMBERS) {
  for (const body of bodies(n)) {
    for (const status of [400, 404, 409, 422]) {
      for (const [tool, args] of ALL_TOOLS) {
        answer(status, body);
        const out = await run(tool, args);
        assert.ok(!DIGITS.test(out), `digits reached the model: ${out} (${status} ${JSON.stringify(body)})`);
        assert.equal(out, NEUTRAL, `${status} ${JSON.stringify(body)}`);
        for (const l of logs) assert.ok(!DIGITS.test(l), `digits in log: ${l}`);
      }
    }
  }
}
// formatRefusal itself never speaks a digit run either
assert.equal(formatRefusal({ error: 'x', message: 'appeler le 0501234567' }), NEUTRAL);

// ---- 401 / 500 / non-JSON 400 / JSON 400 without `error` → throws as today ----

const expectThrow = async (status: number, body: string, tool: unknown, args: unknown, path: string) => {
  answer(status, body);
  await assert.rejects(run(tool, args), (e: Error) => {
    assert.equal(e.message, `${path} → HTTP ${status} : ${body.slice(0, 200)}`);
    return true;
  });
};
const UNAUTH = JSON.stringify({ error: 'unauthorized_agent_caller' });
await expectThrow(401, UNAUTH, cal.book_appointment, BOOK_ARGS, '/api/calendar/book');
await expectThrow(401, UNAUTH, cal.check_availability, { date: '2026-12-01' }, '/api/calendar/availability');
await expectThrow(500, JSON.stringify({ error: 'boom' }), cal.book_appointment, BOOK_ARGS, '/api/calendar/book');
await expectThrow(
  500,
  JSON.stringify({ error: 'boom' }),
  cal.reschedule_appointment,
  RESCHEDULE_ARGS,
  '/api/calendar/reschedule',
);
await expectThrow(502, 'Bad Gateway', cal.find_appointment, { phone: '+15550000001' }, '/api/calendar/find');
await expectThrow(400, '<html>Bad Request</html>', cal.book_appointment, BOOK_ARGS, '/api/calendar/book');
await expectThrow(400, '', cal.cancel_appointment, { event_id: 'evt_mock1' }, '/api/calendar/cancel');
await expectThrow(
  400,
  JSON.stringify({ message: 'no error field' }),
  cal.book_appointment,
  BOOK_ARGS,
  '/api/calendar/book',
);
await expectThrow(400, 'x'.repeat(300), cal.list_available_dates, {}, '/api/calendar/list-dates');

// ---- 2xx → unchanged ----

urls.length = 0;
answer(200, { success: true, summary: 'RDV confirmé le 2026-12-07 à 10:00.' });
assert.equal(await run(cal.book_appointment, { ...BOOK_ARGS, date: '2026-12-07' }), 'RDV confirmé le 2026-12-07 à 10:00.');
// a successful booking still triggers the CRM auto-save
await new Promise((r) => setTimeout(r, 10));
assert.ok(urls.some((u) => u.endsWith('/api/sheets/contact')));

answer(200, { date: '2026-12-07', label: 'Ashdod', available_slots: ['10:00', '11:00'] });
assert.equal(
  await run(cal.check_availability, { date: '2026-12-07', duration: 30 }),
  'Le 2026-12-07 (centre Ashdod), créneaux libres : 10:00, 11:00',
);
// availability's own 200 wrong_day_for_center keeps its branch
answer(200, { ...WRONG_DAY, date: '2026-12-01' });
assert.equal(
  await run(cal.check_availability, { date: '2026-12-01' }),
  'Ashdod est ouvert le lundi uniquement. Propose une de ces dates à la personne.',
);
answer(200, { success: true, summary: 'RDV déplacé au 2026-12-07.' });
assert.equal(await run(cal.reschedule_appointment, RESCHEDULE_ARGS), 'RDV déplacé au 2026-12-07.');
answer(200, { success: true, message: 'RDV annulé.' });
assert.equal(await run(cal.cancel_appointment, { event_id: 'evt_mock1' }), 'RDV annulé.');
answer(200, { events: [] });
assert.equal(await run(cal.find_appointment, { phone: '+15550000001' }), 'Aucun rendez-vous trouvé pour +15550000001.');
answer(200, { success: true, message: 'Contact enregistré.' });
assert.equal(await run(cal.save_contact, { name: 'Mock Client' }), 'Contact enregistré.');
answer(200, { center: 'ashdod', label: 'Ashdod', dates: [{ date: '2026-12-07', weekday: 'lundi' }] });
assert.equal(
  await run(cal.list_available_dates, {}),
  'Prochaines dates ouvertes à Ashdod : lundi 2026-12-07.',
);

// ---- auto-save refused by the web (4xx) is logged without personal data ----

let call = 0;
globalThis.fetch = (async (url: string) => {
  call++;
  if (url.endsWith('/api/sheets/contact')) {
    return new Response(JSON.stringify({ error: 'Google Sheet non connecté pour ce compte.' }), { status: 409 });
  }
  return new Response(JSON.stringify({ success: true, summary: 'ok' }), { status: 200 });
}) as typeof fetch;
{
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await (cal.book_appointment as any).execute(BOOK_ARGS, {}), 'ok');
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.equal(call, 2);
  assert.ok(logs.includes('save_contact (auto) refused by the web'));
  for (const l of logs) assert.ok(!l.includes('Mock Client') && !l.includes('+15550000001'), `leak: ${l}`);
}

console.log('calendar-4xx.test.ts OK');
