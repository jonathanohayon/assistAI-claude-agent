import assert from 'node:assert/strict';

import { checkSafeUrl, isBlockedAddress, type Resolver } from '../src/net/safe-url.js';

const resolvesTo = (...addresses: string[]): Resolver => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

async function reason(url: string, resolver: Resolver = resolvesTo('93.184.216.34')) {
  const r = await checkSafeUrl(url, resolver);
  return r.ok ? 'ok' : r.reason;
}

// an allowed public address
assert.equal(await reason('https://agent.example.com/turn'), 'ok');
assert.equal(await reason('https://agent.example.com/turn', resolvesTo('2606:2800:220:1:248:1893:25c8:1946')), 'ok');
assert.equal(await reason('https://93.184.216.34/turn'), 'ok');

// https only
assert.equal(await reason('http://agent.example.com/turn'), 'not_https');
assert.equal(await reason('ftp://agent.example.com/turn'), 'not_https');
assert.equal(await reason('not a url'), 'invalid_url');
assert.equal(await reason('https://user:pw@agent.example.com/'), 'credentials');

// internal hostnames, refused before any DNS lookup
const noDns: Resolver = async () => { throw new Error('must not resolve'); };
for (const host of ['localhost', 'LOCALHOST.', 'api.localhost', 'db.internal', 'metadata.google.internal', 'printer.local']) {
  assert.equal(await reason(`https://${host}/x`, noDns), 'internal_hostname', host);
}

// every blocked class, as a DNS answer and as an IP literal
const blockedSamples: Record<string, string[]> = {
  private: ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fc00::1', 'fd12:3456::1'],
  loopback: ['127.0.0.1', '127.255.0.9', '::1'],
  linkLocal: ['169.254.10.10', 'fe80::1'],
  metadata: ['169.254.169.254', 'fd00:ec2::254'],
  cgnat: ['100.64.0.1', '100.127.255.254'],
  unspecified: ['0.0.0.0', '::'],
  broadcast: ['255.255.255.255'],
  multicast: ['224.0.0.1', '239.1.2.3', 'ff02::1'],
  mappedV6: ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:a9fe:a9fe'],
};
for (const [cls, addrs] of Object.entries(blockedSamples)) {
  for (const addr of addrs) {
    assert.ok(isBlockedAddress(addr), `${cls}: ${addr} should be blocked`);
    assert.equal(await reason('https://agent.example.com/', resolvesTo(addr)), 'blocked_address', `${cls} via DNS: ${addr}`);
    const literal = addr.includes(':') ? `[${addr}]` : addr;
    assert.equal(await reason(`https://${literal}/`, noDns), 'blocked_address', `${cls} literal: ${addr}`);
  }
}

// numeric host spellings normalise to the blocked address
assert.equal(await reason('https://2130706433/', noDns), 'blocked_address');
assert.equal(await reason('https://0x7f000001/', noDns), 'blocked_address');

// one bad record among several is enough to refuse
assert.equal(await reason('https://agent.example.com/', resolvesTo('93.184.216.34', '10.0.0.5')), 'blocked_address');

// boundaries stay public
assert.ok(!isBlockedAddress('::ffff:8.8.8.8'), 'mapped public stays allowed');
for (const addr of ['172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '8.8.8.8']) {
  assert.ok(!isBlockedAddress(addr), `${addr} should be allowed`);
}

// resolver failure / empty answer
assert.equal(await reason('https://agent.example.com/', async () => { throw new Error('ENOTFOUND'); }), 'dns_failure');
assert.equal(await reason('https://agent.example.com/', resolvesTo()), 'dns_failure');

console.log('safe-url: ok');
