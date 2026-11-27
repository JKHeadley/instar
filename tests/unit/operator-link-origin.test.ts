import { describe, expect, it } from 'vitest';
import {
  createOperatorLinkOriginResolver, originOrNull, DEFAULT_PUBLIC_LINK_MAX_WAIT_MS, PublicLinkPendingError,
} from '../../src/server/dashboardPaths.js';

// Operator-facing links must open on a phone: a configured tunnel that is not up yet means "wait",
// never "send localhost". Only an agent with no tunnel at all uses the local address.
describe('createOperatorLinkOriginResolver', () => {
  const T0 = Date.parse('2026-11-09T20:40:00-08:00');

  it('tunnel configured and up → public origin (trailing slash trimmed)', () => {
    const r = createOperatorLinkOriginResolver({ port: 4042, tunnelConfigured: () => true, tunnelUrl: () => 'https://echo.example.dev/' });
    expect(r()).toEqual({ kind: 'public', origin: 'https://echo.example.dev' });
  });

  it('tunnel configured but not up → pending (no localhost link)', () => {
    const r = createOperatorLinkOriginResolver({ port: 4042, tunnelConfigured: () => true, tunnelUrl: () => null, now: () => T0 });
    expect(r()).toEqual({ kind: 'pending' });
    expect(originOrNull(r())).toBeNull();
  });

  it('a tunnel whose URL read throws counts as not up', () => {
    const r = createOperatorLinkOriginResolver({ port: 4042, tunnelConfigured: () => true, tunnelUrl: () => { throw new Error('x'); }, now: () => T0 });
    expect(r().kind).toBe('pending');
  });

  it('no tunnel configured → local origin', () => {
    const r = createOperatorLinkOriginResolver({ port: 4042, tunnelConfigured: () => false, tunnelUrl: () => null });
    expect(r()).toEqual({ kind: 'local', origin: 'http://localhost:4042', reason: 'no-tunnel' });
    expect(originOrNull(r())).toBe('http://localhost:4042');
  });

  it('a tunnel down past the wait ceiling falls back to local so the notice is not withheld forever; the clock resets once up', () => {
    let now = T0;
    let url: string | null = null;
    const r = createOperatorLinkOriginResolver({ port: 4042, tunnelConfigured: () => true, tunnelUrl: () => url, now: () => now });
    expect(r().kind).toBe('pending');
    now += DEFAULT_PUBLIC_LINK_MAX_WAIT_MS - 1;
    expect(r().kind).toBe('pending');
    now += 1;
    expect(r()).toEqual({ kind: 'local', origin: 'http://localhost:4042', reason: 'tunnel-wait-exceeded' });
    url = 'https://echo.example.dev';
    expect(r().kind).toBe('public');
    url = null;
    now += 60_000;
    expect(r().kind).toBe('pending'); // a fresh outage starts a fresh wait
  });

  it('PublicLinkPendingError is a named Error (delivery paths that retry on rejection retry it)', () => {
    const e = new PublicLinkPendingError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('PublicLinkPendingError');
  });
});
