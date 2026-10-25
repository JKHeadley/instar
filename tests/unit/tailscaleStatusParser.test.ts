/**
 * U4.5 — parseTailscaleStatus (u4-5-rope-health-alerts §2/§6, R-r2-3).
 *
 * REGISTERED parser (Scrape/Parser Fixture Realness): fed the captured
 * byte-for-byte fixtures in tests/fixtures/captured/tailscale-status/ — the
 * real `tailscale status --json` output (same-length redactions preserve every
 * structural byte) and the real plain `tailscale status` output (the
 * wrong-invocation/malformed arm).
 *
 * CONTENT-SCRUB (the hard rule): the raw JSON carries IP-shaped, email-shaped
 * and tailnet-shaped values (redacted same-shape, deliberately retained) — the
 * parser output must contain NONE of them. Only role + KeyExpiry survive.
 */
import { describe, it, expect } from 'vitest';
import { parseTailscaleStatus, soonestKeyExpiry } from '../../src/core/tailscaleStatusParser.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

// Loaded per-test where the lint's realness contract requires it; shared here
// for the scrub/soonest tests (same bytes).
const fullRaw = loadCapturedFixture('tailscale-status', 'status-full');
const plainRaw = loadCapturedFixture('tailscale-status', 'status-plain-nonjson');

describe('parseTailscaleStatus (registered parser — captured fixtures)', () => {
  it('parses the REAL captured tailscale status --json byte-for-byte', () => {
    const full = loadCapturedFixture('tailscale-status', 'status-full');
    const parse = parseTailscaleStatus(full);
    expect(parse.parsed).toBe(true);
    // The capture has Self + 3 peers, every one carrying a KeyExpiry.
    expect(parse.entries).toHaveLength(4);
    expect(parse.entries[0].role).toBe('self');
    expect(parse.entries.filter((e) => e.role === 'peer')).toHaveLength(3);
    for (const e of parse.entries) {
      expect(e.keyExpiryIso).toBeTypeOf('string');
      expect(Number.isFinite(Date.parse(e.keyExpiryIso!))).toBe(true);
    }
    // The capture's real self expiry (unredacted — it is the parse target).
    expect(parse.entries[0].keyExpiryIso).toBe(new Date('2026-12-29T00:30:05Z').toISOString());
  });

  it('CONTENT SCRUB: IP/email/tailnet/hostname-shaped fixture values NEVER reach parser output', () => {
    // The fixture deliberately retains same-shape placeholder rows for every
    // sensitive class; prove the raw body carries them...
    expect(fullRaw).toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/); // IP-shaped
    expect(fullRaw).toContain('@'); // email-shaped login
    expect(fullRaw).toContain('.ts.net'); // tailnet-shaped
    expect(fullRaw).toContain('nodekey:'); // key material shape
    // ...and that NONE of them survive the parser.
    const out = JSON.stringify(parseTailscaleStatus(fullRaw));
    expect(out).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(out).not.toContain('@');
    expect(out).not.toContain('ts.net');
    expect(out).not.toContain('nodekey');
    expect(out).not.toMatch(/HostName|DNSName|TailscaleIPs|Relay/);
  });

  it('the REAL plain (non---json) output classifies as not-parsed — the tier goes silently absent, never a throw', () => {
    const parse = parseTailscaleStatus(plainRaw);
    expect(parse.parsed).toBe(false);
    expect(parse.entries).toHaveLength(0);
  });

  it('a JSON body that is not the tailscale contract (no BackendState) is not-parsed', () => {
    expect(parseTailscaleStatus('{"hello":"world"}').parsed).toBe(false);
    expect(parseTailscaleStatus('null').parsed).toBe(false);
    expect(parseTailscaleStatus('[]').parsed).toBe(false);
  });

  it('a node without KeyExpiry yields a null entry (tolerant), and garbage expiry is null', () => {
    const parse = parseTailscaleStatus(JSON.stringify({
      BackendState: 'Running',
      Self: { HostName: 'x' },
      Peer: { k1: { KeyExpiry: 'not-a-date' } },
    }));
    expect(parse.parsed).toBe(true);
    expect(parse.entries).toEqual([
      { role: 'self', keyExpiryIso: null, backsMeshRope: true },
      { role: 'peer', keyExpiryIso: null, backsMeshRope: true },
    ]);
  });
});

describe('soonestKeyExpiry', () => {
  it('picks the soonest expiry across self + peers from the real capture', () => {
    const parse = parseTailscaleStatus(fullRaw);
    const now = Date.parse('2026-07-02T00:00:00Z');
    const soonest = soonestKeyExpiry(parse, now)!;
    // The capture's soonest is the 2026-08-13 peer key (~42 days out).
    expect(soonest.role).toBe('peer');
    expect(soonest.expiresAtIso).toBe(new Date('2026-08-13T05:48:14Z').toISOString());
    expect(soonest.inDays).toBeGreaterThan(41);
    expect(soonest.inDays).toBeLessThan(43);
  });

  it('returns null when nothing carries an expiry', () => {
    expect(soonestKeyExpiry({ parsed: true, entries: [{ role: 'self', keyExpiryIso: null, backsMeshRope: true }] }, 0)).toBeNull();
  });
});

/**
 * Mesh-scoping (2026-08-29): a tailnet holds every device the operator owns, but only a
 * handful back a mesh rope. Scanning the whole tailnet for the soonest key expiry made a
 * long-dead unrelated node the permanent global minimum, so the digest warned forever
 * while every real mesh machine's key was months from expiry.
 */
describe('tailscaleStatusParser — mesh scoping', () => {
  const MESH_IP = '100.64.165.27';
  const DEAD_IP = '100.89.225.62';
  const SELF_IP = '100.124.55.70';
  const NOW = Date.parse('2026-08-29T19:00:00.000Z');

  const raw = JSON.stringify({
    BackendState: 'Running',
    Self: { TailscaleIPs: [SELF_IP], KeyExpiry: '2027-02-15T03:47:45Z' },
    Peer: {
      'k:mesh': { TailscaleIPs: [MESH_IP], KeyExpiry: '2026-12-11T18:50:57Z' },
      'k:dead': { TailscaleIPs: [DEAD_IP], KeyExpiry: '2026-08-13T05:48:14Z' },
    },
  });

  it('flags only the nodes that back a mesh rope (self always counts)', () => {
    const parse = parseTailscaleStatus(raw, new Set([MESH_IP]));
    expect(parse.parsed).toBe(true);
    expect(parse.entries.map((e) => [e.role, e.backsMeshRope])).toEqual([
      ['self', true],
      ['peer', true],
      ['peer', false],
    ]);
  });

  it('mesh-scoped: the long-dead unrelated node no longer sets the soonest expiry', () => {
    const parse = parseTailscaleStatus(raw, new Set([MESH_IP]));
    const soonest = soonestKeyExpiry(parse, NOW, { meshScopedOnly: true });
    expect(soonest?.expiresAtIso).toBe('2026-12-11T18:50:57.000Z');
    expect(soonest!.inDays).toBeGreaterThan(90);
  });

  it('un-scoped: the same input still reports the dead node (the pre-fix behaviour)', () => {
    const soonest = soonestKeyExpiry(parseTailscaleStatus(raw), NOW);
    expect(soonest?.expiresAtIso).toBe('2026-08-13T05:48:14.000Z');
    expect(soonest!.inDays).toBeLessThan(0);
  });

  it('no address set ⇒ every node backs a rope (back-compatible)', () => {
    expect(parseTailscaleStatus(raw).entries.every((e) => e.backsMeshRope)).toBe(true);
    expect(parseTailscaleStatus(raw, new Set()).entries.every((e) => e.backsMeshRope)).toBe(true);
  });

  it('SELF still warns when scoped, even though its own address is not a mesh peer address', () => {
    const selfSoon = JSON.stringify({
      BackendState: 'Running',
      Self: { TailscaleIPs: [SELF_IP], KeyExpiry: '2026-08-30T00:00:00Z' },
      Peer: { 'k:mesh': { TailscaleIPs: [MESH_IP], KeyExpiry: '2027-02-15T03:47:45Z' } },
    });
    const soonest = soonestKeyExpiry(parseTailscaleStatus(selfSoon, new Set([MESH_IP])), NOW, {
      meshScopedOnly: true,
    });
    expect(soonest?.role).toBe('self');
  });

  it('a node with no TailscaleIPs array is not treated as mesh-backing', () => {
    const odd = JSON.stringify({
      BackendState: 'Running',
      Peer: { 'k:x': { KeyExpiry: '2026-08-13T05:48:14Z' } },
    });
    const parse = parseTailscaleStatus(odd, new Set([MESH_IP]));
    expect(parse.entries[0].backsMeshRope).toBe(false);
    expect(soonestKeyExpiry(parse, NOW, { meshScopedOnly: true })).toBeNull();
  });
});
