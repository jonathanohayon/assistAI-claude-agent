import assert from 'node:assert/strict';

import { AGENT_NAME, resolveAgentName } from '../config.js';

// production default: inbound SIP is dispatched to this name
assert.equal(AGENT_NAME, 'appointment-agent');
assert.equal(resolveAgentName({}), 'appointment-agent');
assert.equal(resolveAgentName({ AGENT_NAME: '   ' }), 'appointment-agent');

// a test worker registers under its own name and never takes production calls
assert.equal(resolveAgentName({ AGENT_NAME: ' appointment-agent-staging ' }), 'appointment-agent-staging');

console.log('ALL AGENT-NAME TESTS PASSED');
