import assert from 'node:assert/strict';

import { findSipCallerIdentity, transferEligible, transferTarget } from '../src/transfer.js';

// eligibility: PSTN calls with a valid E.164 transfer number only
assert.equal(transferEligible({ originKind: 'sip', channel: 'pstn', transferNumber: '+15550000000' }), true);
assert.equal(transferEligible({ originKind: 'sip', channel: 'whatsapp', transferNumber: '+15550000000' }), false);
assert.equal(transferEligible({ originKind: 'web', transferNumber: '+15550000000' }), false);
assert.equal(transferEligible({ originKind: 'sip', channel: 'pstn', transferNumber: '' }), false);
assert.equal(transferEligible({ originKind: 'sip', channel: 'pstn', transferNumber: undefined }), false);
assert.equal(transferEligible({ originKind: 'sip', channel: 'pstn', transferNumber: '0550000000' }), false);

// REFER target
assert.equal(transferTarget('+15550000000'), 'tel:+15550000000');

// the caller's SIP leg, not the agent or a web participant
assert.equal(
  findSipCallerIdentity([
    { identity: 'agent-1', attributes: {} },
    { identity: 'sip_+15550000001', attributes: { 'sip.phoneNumber': '+15550000001' } },
  ]),
  'sip_+15550000001',
);
assert.equal(findSipCallerIdentity([{ identity: 'sip_+15550000002', attributes: {} }]), 'sip_+15550000002');
assert.equal(findSipCallerIdentity([{ identity: 'web-u1', attributes: {} }]), null);
assert.equal(findSipCallerIdentity([]), null);

console.log('ALL TRANSFER TESTS PASSED');
