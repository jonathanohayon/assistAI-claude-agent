import assert from 'node:assert/strict';

import { configFallbackLog, refusalFromResponse } from '../src/config-refusal.js';

// an unknown dialed number ends the call instead of using the default persona
assert.equal(refusalFromResponse(404, { error: 'unknown_number' }), 'unknown_number');

// an exhausted trial ends the call (the 403 used to fall back to defaults)
assert.equal(refusalFromResponse(403, { error: 'trial_exhausted' }), 'trial_exhausted');

// any other failure keeps the defaults: an outage on our side must not drop calls
assert.equal(refusalFromResponse(404, { error: 'No tenant' }), null);
assert.equal(refusalFromResponse(500, { error: 'unknown_number' }), null);
assert.equal(refusalFromResponse(502, null), null);
assert.equal(refusalFromResponse(403, 'trial_exhausted'), null);

// a 401 (secret mismatch) is a loud, greppable error, not a quiet warning
const auth = configFallbackLog(401, '/api/agent/config?phone=%2B15550000002');
assert.equal(auth.level, 'error');
assert.match(auth.message, /^\[config_auth_failed\] \/api\/agent\/config → 401/);
// the query string (a phone number) never reaches the log
assert.ok(!auth.message.includes('15550000002'));
assert.equal(configFallbackLog(403, '/api/agent/campaign-config?x=1').level, 'error');

// other failures stay a warning
const outage = configFallbackLog(502, '/api/agent/config?userId=u1');
assert.equal(outage.level, 'warn');
assert.equal(outage.message, '[config] /api/agent/config → 502, using defaults');

console.log('ALL CONFIG-REFUSAL TESTS PASSED');
