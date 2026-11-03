import assert from 'node:assert/strict';

import { buildSessionInstructions } from '../src/per-call-context.js';

const STATIC = 'STATIC TENANT PROMPT (long, identical on every call)';
const CTX = '### Temporal Context\nToday is 2030-03-05, 10:30. Caller: +15550000002';

// the per-call context is in the instructions (not in a chat-context item)…
const full = buildSessionInstructions(STATIC, CTX);
assert.ok(full.includes(CTX));
// …at the END, so the static part stays an identical prefix for the prompt cache
assert.ok(full.startsWith(STATIC));
assert.equal(full, `${STATIC}\n\n${CTX}`);
// two calls share the exact same prefix up to the context
const other = buildSessionInstructions(STATIC, '### Temporal Context\nToday is 2030-03-06, 18:00.');
assert.equal(other.slice(0, STATIC.length), full.slice(0, STATIC.length));
// no context (or whitespace): the static prompt alone, unchanged
assert.equal(buildSessionInstructions(STATIC, ''), STATIC);
assert.equal(buildSessionInstructions(STATIC, '  \n '), STATIC);

console.log('ALL SESSION-INSTRUCTIONS TESTS PASSED');
