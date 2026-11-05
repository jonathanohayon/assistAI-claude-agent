import assert from 'node:assert/strict';

import {
  callStateFromSipStatus,
  createCampaignProgressReporter,
  type ProgressPayload,
} from '../src/campaign-progress.js';

assert.equal(callStateFromSipStatus('dialing'), null);
assert.equal(callStateFromSipStatus('ringing'), 'ringing');
assert.equal(callStateFromSipStatus('active'), 'in_call');
assert.equal(callStateFromSipStatus('hangup'), 'ended');
assert.equal(callStateFromSipStatus(undefined), null);

// answered call: each state once, forward only, talk time measured from answer
{
  const sent: ProgressPayload[] = [];
  let t = 1_000;
  const r = createCampaignProgressReporter(
    { campaignId: 'c-1', contactId: 'k-1' },
    async (p) => void sent.push(p),
    () => t,
  );
  r.onSipStatus('dialing');
  r.onSipStatus('ringing');
  r.onSipStatus('ringing');
  t = 5_000;
  r.onSipStatus('active');
  r.onSipStatus('ringing'); // late/out of order: ignored
  t = 47_000;
  r.onSipStatus('hangup');
  r.ended(); // session close after hangup: no duplicate
  assert.deepEqual(
    sent.map((p) => p.state),
    ['ringing', 'in_call', 'ended'],
  );
  assert.equal(sent[2]?.durationSeconds, 42);
  assert.equal(sent[0]?.campaignId, 'c-1');
}

// never answered: session close reports ended with 0 s
{
  const sent: ProgressPayload[] = [];
  const r = createCampaignProgressReporter({ campaignId: 'c-2', contactId: 'k-2' }, async (p) => void sent.push(p));
  r.onSipStatus('ringing');
  r.ended();
  assert.deepEqual(sent.map((p) => [p.state, p.durationSeconds]), [['ringing', undefined], ['ended', 0]]);
}

console.log('ALL CAMPAIGN-PROGRESS TESTS PASSED');
