// Knowledge S6a (worker): nothing reads the deprecated inbound `knowledge`
// array. fetchConfig never forwarded it, so the removed knowledge tools could
// never be built (dead code) — this guards against a reader coming back.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
assert.equal(existsSync(`${root}tools/knowledge.ts`), false, 'tools/knowledge.ts removed');
const hits = execSync(
  `git grep -nE "cfg\\\\.knowledge|data\\\\.knowledge|makeKnowledgeTools|KnowledgeEntry" -- agent.ts src tools || true`,
  { cwd: root, encoding: 'utf8' },
).trim();
assert.equal(hits, '', `unexpected reader of the legacy knowledge array:\n${hits}`);
console.log('ALL NO-KNOWLEDGE-READER TESTS PASSED');
