import { lookup } from 'node:dns/promises';
import type { LookupAllOptions, LookupOneOptions } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * Connect-time check for a customer-supplied URL (legacy BYO-agent webhook).
 *
 * The worker POSTs to a URL a tenant typed in. Without a check, that URL can
 * point the worker at our own network: loopback, private ranges, the cloud
 * metadata service. Rules: https only, no internal hostnames, and every DNS
 * record of the host must be a public address.
 *
 * DNS rebinding: `guardedLookup` runs the DNS rules at connect time, as the
 * socket's own `lookup`, so the address checked is the address connected to.
 *
 * Same rules as lib/net/safe-url.ts on the web side.
 */

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Resolves every A/AAAA record of a host. Injectable so tests need no network. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultResolver: Resolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

export type UnsafeReason =
  | 'invalid_url'
  | 'not_https'
  | 'credentials'
  | 'internal_hostname'
  | 'blocked_address'
  | 'dns_failure';

export type SafeUrlResult = { ok: true } | { ok: false; reason: UnsafeReason };

const blocked = new BlockList();
// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // unspecified / "this network"
blocked.addSubnet('10.0.0.0', 8, 'ipv4'); // private
blocked.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, incl. metadata 169.254.169.254
blocked.addSubnet('172.16.0.0', 12, 'ipv4'); // private
blocked.addSubnet('192.168.0.0', 16, 'ipv4'); // private
blocked.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved, incl. broadcast 255.255.255.255
// IPv6
blocked.addAddress('::', 'ipv6'); // unspecified
blocked.addAddress('::1', 'ipv6'); // loopback
blocked.addSubnet('fc00::', 7, 'ipv6'); // unique local, incl. metadata fd00:ec2::254
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); // multicast

// IPv4-mapped IPv6 (::ffff:a.b.c.d). Kept in its own list: a BlockList also
// matches plain IPv4 against a mapped rule, which would block every address.
const mapped = new BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');

/** The IPv4 address inside an IPv4-mapped IPv6 address, any spelling. */
function embeddedIPv4(v6: string): string | null {
  if (!mapped.check(v6, 'ipv6')) return null;
  // The URL parser canonicalises to ::ffff:hhhh:hhhh.
  const canonical = new URL(`http://[${v6}]/`).hostname.replace(/^\[|\]$/g, '');
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!m?.[1] || !m[2]) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True when an IP literal must never be contacted. Unknown formats are refused. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, 'ipv4');
  if (family === 6) {
    if (mapped.check(bare, 'ipv6')) {
      const v4 = embeddedIPv4(bare);
      return v4 ? blocked.check(v4, 'ipv4') : true;
    }
    return blocked.check(bare, 'ipv6');
  }
  return true;
}

function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h === 'internal' ||
    h.endsWith('.local') ||
    h === 'local'
  );
}

/**
 * URL-shape rules, no DNS: https only, no credentials, no internal hostname,
 * and an IP-literal host must be public (Node skips `lookup` for literals,
 * so this is where literals are checked). Never throws.
 */
export function checkUrlShape(rawUrl: string): SafeUrlResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'invalid_url' };

  if (isIP(host)) {
    return isBlockedAddress(host) ? { ok: false, reason: 'blocked_address' } : { ok: true };
  }
  if (isInternalHostname(host)) return { ok: false, reason: 'internal_hostname' };
  return { ok: true };
}

export type ResolvedHostResult =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; reason: UnsafeReason };

/** Resolves a hostname; refuses it unless every record is public. Never throws. */
export async function resolvePublicHost(
  hostname: string,
  resolve: Resolver = defaultResolver,
): Promise<ResolvedHostResult> {
  if (isIP(hostname)) {
    return isBlockedAddress(hostname)
      ? { ok: false, reason: 'blocked_address' }
      : { ok: true, addresses: [{ address: hostname, family: isIP(hostname) }] };
  }
  if (isInternalHostname(hostname)) return { ok: false, reason: 'internal_hostname' };
  let records: ResolvedAddress[];
  try {
    records = await resolve(hostname);
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }
  if (records.length === 0) return { ok: false, reason: 'dns_failure' };
  if (records.some((r) => isBlockedAddress(r.address))) {
    return { ok: false, reason: 'blocked_address' };
  }
  return { ok: true, addresses: records };
}

/**
 * Full check, shape + DNS. Never throws. The reason is for logs only and
 * never carries the URL or an address. Same rules as lib/net/safe-url.ts.
 */
export async function checkSafeUrl(
  rawUrl: string,
  resolve: Resolver = defaultResolver,
): Promise<SafeUrlResult> {
  const shape = checkUrlShape(rawUrl);
  if (!shape.ok) return shape;
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return { ok: true };
  const resolved = await resolvePublicHost(host, resolve);
  return resolved.ok ? { ok: true } : resolved;
}

/** Error raised by `guardedLookup`; `reason` is safe to log. */
export class UnsafeAddressError extends Error {
  readonly code: string;
  constructor(readonly reason: UnsafeReason) {
    super(`refused at connect (${reason})`);
    this.code = reason === 'dns_failure' ? 'ENOTFOUND' : 'EUNSAFEADDR';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void;

/**
 * `lookup` for net/tls/https: resolves the host and refuses it at CONNECT
 * time unless every record is public. The socket then connects to one of the
 * addresses checked here, so there is no second resolution to rebind
 * between check and connect. TLS SNI and Host stay the hostname.
 */
export function guardedLookup(resolve: Resolver = defaultResolver): LookupFunction {
  const lookupFn = (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions | LookupCallback,
    maybeCallback?: LookupCallback,
  ): void => {
    const callback = (typeof options === 'function' ? options : maybeCallback) as LookupCallback;
    const opts = typeof options === 'object' && options ? options : {};
    void resolvePublicHost(hostname, resolve).then((result) => {
      if (!result.ok) {
        callback(new UnsafeAddressError(result.reason), opts.all ? [] : '', undefined);
        return;
      }
      const wanted = opts.family === 4 || opts.family === 6 ? opts.family : 0;
      const addresses = wanted
        ? result.addresses.filter((a) => a.family === wanted)
        : result.addresses;
      const first = addresses[0];
      if (!first) {
        callback(new UnsafeAddressError('dns_failure'), opts.all ? [] : '', undefined);
        return;
      }
      if (opts.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
  return lookupFn as unknown as LookupFunction;
}
