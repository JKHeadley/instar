/**
 * SEC-139: the one place the relay decides which address a request came from.
 *
 * The first `x-forwarded-for` entry, which the relay used before, is whatever the caller wrote, so
 * any caller could pick its own address and get a fresh rate-limit bucket on every request. Now no
 * header is trusted unless the deployment names one (`RELAY_CLIENT_IP_HEADER`), because only the
 * deployment knows which proxy sits in front and which header that proxy sets itself:
 * - a named single-address header (for example Fly's `fly-client-ip`) is used when it holds one
 *   valid IP address;
 * - `x-forwarded-for` as the named header means its right-most entry, the one the nearest proxy
 *   appended, never the left-most one the caller controls;
 * - otherwise, or when the value is not a valid address, the socket address is used.
 * Two forms come back: `exact` (IPv4-mapped IPv6 folded to IPv4, IPv6 written canonically) for
 * anything that must separate two hosts, such as A2A thread scope; and `rateKey`, the same but with
 * IPv6 reduced to its /64 network, for rate limits, so one subscriber cannot rotate through its
 * /64 for fresh buckets.
 */
import net from 'node:net';
import type { IncomingMessage } from 'node:http';

/** Expands a valid IPv6 address to eight 4-digit groups, or returns null. */
function expandIPv6(addr: string): string[] | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (tail) {
    const o = tail[1].split('.').map(Number);
    a = a.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

/** The exact canonical address: IPv4-mapped IPv6 folded to IPv4, IPv6 as eight full groups. */
export function exactAddress(addr: string): string {
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (v4) return v4[1];
  if (net.isIPv6(addr)) {
    const g = expandIPv6(addr);
    if (g) return g.join(':');
  }
  return addr.toLowerCase();
}

/**
 * The rate-limit key: as `exactAddress`, but IPv6 by its /64 network, because one subscriber is
 * usually given a whole /64 and could otherwise rotate through 2^64 addresses, each a fresh bucket.
 */
export function normalizeAddress(addr: string): string {
  const exact = exactAddress(addr);
  if (net.isIPv6(exact)) return `${exact.split(':').slice(0, 4).join(':')}::/64`;
  return exact;
}

/** Both forms of the caller address (see the file header). */
export function resolveClientAddressParts(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustedHeader?: string | null,
): { exact: string; rateKey: string } {
  const raw = pickRawAddress(req, trustedHeader);
  return raw ? { exact: exactAddress(raw), rateKey: normalizeAddress(raw) } : { exact: 'unknown', rateKey: 'unknown' };
}

/** The rate-limit key for the caller (the form every relay limiter uses). */
export function resolveClientAddress(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustedHeader?: string | null): string {
  return resolveClientAddressParts(req, trustedHeader).rateKey;
}

function pickRawAddress(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustedHeader?: string | null): string | null {
  const name = trustedHeader?.trim().toLowerCase();
  if (name) {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (typeof value === 'string') {
      const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
      const candidate = name === 'x-forwarded-for' ? parts[parts.length - 1] : (parts.length === 1 ? parts[0] : undefined);
      if (candidate && net.isIP(candidate)) return candidate;
    }
  }
  return req.socket?.remoteAddress || null;
}
