import assert from 'node:assert/strict';

import { classifyRealtimeError, createFatalGate } from '../src/realtime-errors.js';

// an invalid key is fatal: the session can never recover
assert.equal(classifyRealtimeError('invalid_api_key'), 'fatal');
assert.equal(classifyRealtimeError('insufficient_quota'), 'fatal');

// the known cancel race stays benign
assert.equal(classifyRealtimeError('response_cancel_not_active'), 'benign');

// unknown or missing codes are ordinary errors, not a reason to hang up
assert.equal(classifyRealtimeError('rate_limit_exceeded'), 'other');
assert.equal(classifyRealtimeError(undefined), 'other');
assert.equal(classifyRealtimeError(''), 'other');

// the gate fires once per call, even if OpenAI repeats the error thousands of times
{
  const gate = createFatalGate();
  assert.equal(gate('rate_limit_exceeded'), false);
  assert.equal(gate('invalid_api_key'), true);
  let again = 0;
  for (let i = 0; i < 10_000; i++) if (gate('invalid_api_key')) again++;
  assert.equal(again, 0);
}

console.log('ALL REALTIME-ERRORS TESTS PASSED');
