import assert from 'node:assert/strict';

import { clientProfileLine, parseClientProfile } from '../src/client-profile.js';

// malformed / absent → no profile → no line (call unchanged)
assert.equal(parseClientProfile(null), null);
assert.equal(parseClientProfile({}), null);
assert.equal(parseClientProfile({ visits: -1 }), null);
assert.equal(parseClientProfile({ visits: 'many' }), null);
assert.equal(clientProfileLine(null), '');

const regular = parseClientProfile({
  visits: 4,
  lastVisitAt: '2026-10-01T06:00:00.000Z',
  nextVisitAt: null,
  regular: true,
  name: 'Dana Mock',
});
assert.deepEqual(regular, {
  visits: 4,
  lastVisitAt: '2026-10-01T06:00:00.000Z',
  nextVisitAt: null,
  regular: true,
  name: 'Dana Mock',
});
const line = clientProfileLine(regular);
assert.match(line, /^\*\*PERSONNE DÉJÀ CLIENTE \(RÉGULIÈRE\)\*\*/);
assert.match(line, /4 visites, dernière visite le 1 octobre/);
assert.match(line, /Dana Mock, à confirmer/);
assert.ok(!line.includes('\n'), 'one line');

// returning but not regular
const once = clientProfileLine(parseClientProfile({ visits: 1, lastVisitAt: '2026-10-01T06:00:00.000Z', regular: false, name: '' }));
assert.match(once, /^\*\*PERSONNE DÉJÀ CLIENTE\*\* : 1 visite, /);
assert.ok(!once.includes('prénom sur ses rendez-vous'));

// no past visit but a booking ahead: mention it; nothing at all → no line
assert.match(
  clientProfileLine(parseClientProfile({ visits: 0, nextVisitAt: '2026-11-20T08:00:00.000Z', name: '' })),
  /rendez-vous est déjà prévu le 20 novembre/,
);
assert.equal(clientProfileLine(parseClientProfile({ visits: 0, nextVisitAt: null })), '');

// garbage dates are dropped, not rendered
assert.equal(parseClientProfile({ visits: 2, lastVisitAt: 'yesterday' })?.lastVisitAt, null);

// gender-neutral: no gendered client noun or adjective in any variant
const GENDERED = /\b(cliente|client connu|habitu[ée]e?s?|fid[èe]le|connue|venue|accueille-le)\b/i;
for (const variant of [
  line,
  once,
  clientProfileLine(parseClientProfile({ visits: 0, nextVisitAt: '2026-11-20T08:00:00.000Z', name: '' })),
]) {
  assert.ok(variant.length > 0);
  assert.ok(!GENDERED.test(variant.replace(/PERSONNE DÉJÀ (CLIENTE|CONNUE)/, '')), `gendered wording: ${variant}`);
  assert.match(variant, /Adapte le genre grammatical uniquement si le prénom ou la voix le rend certain/);
}

console.log('ALL CLIENT-PROFILE TESTS PASSED');
