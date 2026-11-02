import assert from 'node:assert/strict';

import { classifyRealtimeError, createFatalGate, geminiErrorCode } from '../src/realtime-errors.js';

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

// Gemini Live: WebSocket close (code + reason) mapped to fatal codes
const close = (code: number, reason: string) => ({
  message: reason,
  statusCode: code,
  body: { reason, code },
});
assert.equal(geminiErrorCode(close(1008, 'API key not valid. Please pass a valid API key.')), 'gemini_auth');
assert.equal(geminiErrorCode(close(1008, 'Permission denied')), 'gemini_auth');
assert.equal(geminiErrorCode(close(1011, 'You exceeded your current quota, please check your plan and billing details.')), 'gemini_quota');
assert.equal(geminiErrorCode(close(1011, 'RESOURCE_EXHAUSTED')), 'gemini_quota');
assert.equal(geminiErrorCode(close(1007, 'models/gemini-x is not found for API version v1beta')), 'gemini_invalid_request');
assert.equal(geminiErrorCode(close(1008, '')), 'gemini_auth');
// a transient server error is not fatal; junk is ignored
assert.equal(geminiErrorCode(close(1011, 'Internal error encountered.')), null);
assert.equal(geminiErrorCode(null), null);
assert.equal(geminiErrorCode('boom'), null);
// the mapped codes go through the same once-per-call gate
for (const c of ['gemini_auth', 'gemini_quota', 'gemini_invalid_request']) {
  assert.equal(classifyRealtimeError(c), 'fatal');
}
const g = createFatalGate();
assert.equal(g('gemini_auth'), true);
assert.equal(g('gemini_auth'), false);

console.log('ALL REALTIME-ERRORS TESTS PASSED');
