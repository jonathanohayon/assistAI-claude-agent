import assert from 'node:assert/strict';

import { refusalFromResponse } from '../src/config-refusal.js';

// an unknown dialed number ends the call instead of using the default persona
assert.equal(refusalFromResponse(404, { error: 'unknown_number' }), 'unknown_number');

// an exhausted trial ends the call (the 403 used to fall back to defaults)
assert.equal(refusalFromResponse(403, { error: 'trial_exhausted' }), 'trial_exhausted');

// any other failure keeps the defaults: an outage on our side must not drop calls
assert.equal(refusalFromResponse(404, { error: 'No tenant' }), null);
assert.equal(refusalFromResponse(500, { error: 'unknown_number' }), null);
assert.equal(refusalFromResponse(502, null), null);
assert.equal(refusalFromResponse(403, 'trial_exhausted'), null);

console.log('ALL CONFIG-REFUSAL TESTS PASSED');
