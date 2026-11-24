import assert from 'node:assert/strict';

// Mock web env only — no real host, no real secret.
process.env['APP_URL'] = 'http://web.invalid';

const { demoFallbackWarnings, DEMO_FALLBACK_SECRET_WARNING, DEMO_FALLBACK_NUMBER_WARNING } = await import(
  '../src/demo-fallback-warning.js'
);
const { makeCalendarTools } = await import('../tools/calendar.js');
const { makeOrdersTools } = await import('../tools/orders.js');
const { FALLBACK_FEATURES, defaultConfig } = await import('../src/config-fetcher.js');

// Builds the tool maps the way agent.ts does, then prints the warnings the way
// agent.ts does, capturing console.warn.
function warningsFor(opts: {
  features: { calendar: boolean; crm: boolean };
  ordersEnabled: boolean;
  internalSecret: string;
  dialedNumber: string;
}): string[] {
  const calendarTools = makeCalendarTools({
    dialedPhone: opts.dialedNumber,
    getDialedPhone: () => opts.dialedNumber,
    tenantUserId: '',
    getCallerPhone: () => '0500000000',
    features: opts.features,
  });
  const ordersTools = opts.ordersEnabled
    ? makeOrdersTools({ dialedPhone: opts.dialedNumber, tenantUserId: '', getCallerPhone: () => '0500000000' })
    : {};
  const printed: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void printed.push(args.map(String).join(' '));
  try {
    for (const line of demoFallbackWarnings({
      tenantRoutedToolNames: [...Object.keys(calendarTools), ...Object.keys(ordersTools)],
      internalSecret: opts.internalSecret,
      dialedNumber: opts.dialedNumber,
    })) {
      console.warn(line);
    }
  } finally {
    console.warn = original;
  }
  return printed;
}

const fallback = defaultConfig();

// neutral fallback (tools = end_call only): neither warning prints, even with no secret and no number
assert.deepEqual(
  warningsFor({
    features: { calendar: FALLBACK_FEATURES.calendar !== false, crm: FALLBACK_FEATURES.crm !== false },
    ordersEnabled: fallback.ordersEnabled === true,
    internalSecret: '',
    dialedNumber: '',
  }),
  [],
);

// calendar tools registered, no secret: the secret warning prints once
assert.deepEqual(
  warningsFor({ features: { calendar: true, crm: false }, ordersEnabled: false, internalSecret: '', dialedNumber: '+15550000000' }),
  [DEMO_FALLBACK_SECRET_WARNING],
);

// calendar tools registered, no dialed number: the number warning prints once
assert.deepEqual(
  warningsFor({ features: { calendar: true, crm: true }, ordersEnabled: false, internalSecret: 'test-secret', dialedNumber: '' }),
  [DEMO_FALLBACK_NUMBER_WARNING],
);

// calendar tools registered, both conditions true: each prints exactly once
assert.deepEqual(
  warningsFor({ features: { calendar: true, crm: true }, ordersEnabled: false, internalSecret: '', dialedNumber: '' }),
  [DEMO_FALLBACK_SECRET_WARNING, DEMO_FALLBACK_NUMBER_WARNING],
);

// a sheet-only tool counts too: save_contact alone, or record_order alone
assert.deepEqual(
  warningsFor({ features: { calendar: false, crm: true }, ordersEnabled: false, internalSecret: '', dialedNumber: '' }).length,
  2,
);
assert.deepEqual(
  warningsFor({ features: { calendar: false, crm: false }, ordersEnabled: true, internalSecret: '', dialedNumber: '' }).length,
  2,
);

// tools registered and everything set: nothing prints
assert.deepEqual(
  warningsFor({ features: { calendar: true, crm: true }, ordersEnabled: true, internalSecret: 'test-secret', dialedNumber: '+15550000000' }),
  [],
);

// wording unchanged from the previous inline warnings
assert.equal(
  DEMO_FALLBACK_SECRET_WARNING,
  '[tools] INTERNAL_SECRET not set — calendar/sheet calls will fall back to the demo (admin) account on the web service.',
);
assert.equal(
  DEMO_FALLBACK_NUMBER_WARNING,
  '[tools] dialed number unresolved — calendar/sheet calls will fall back to the demo (admin) account on the web service.',
);

console.log('demo-fallback-warning: ok');
