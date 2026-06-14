/**
 * Tier-1 — peerUrlGuard: the https/allowlist check a pool fan-out must pass
 * BEFORE attaching the Bearer token to a peer URL
 * (GUARD-POSTURE-ENDPOINT-SPEC §3(c)).
 */
import { describe, expect, it } from 'vitest';
import { isPeerUrlAllowedForCredentials } from '../../src/server/peerUrlGuard.js';

describe('isPeerUrlAllowedForCredentials', () => {
  it('allows known tunnel domains over https', () => {
    expect(isPeerUrlAllowedForCredentials('https://abc-def.trycloudflare.com').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('https://echo.dawn-tunnel.dev').ok).toBe(true);
  });

  it('allows localhost + RFC-1918 hosts (http permitted inside the LAN)', () => {
    expect(isPeerUrlAllowedForCredentials('http://localhost:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://127.0.0.1:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://10.0.0.5:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://192.168.1.20:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://172.16.0.9:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://172.31.255.1:4042').ok).toBe(true);
  });

  it('refuses 172.x outside the private /12 and any public http host', () => {
    expect(isPeerUrlAllowedForCredentials('http://172.15.0.1:4042')).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials('http://172.32.0.1:4042')).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials('http://example.com')).toEqual({ ok: false, reason: 'scheme-not-allowed' });
  });

  it('refuses https hosts outside the allowlist — the token never travels there', () => {
    expect(isPeerUrlAllowedForCredentials('https://evil.example.com')).toEqual({ ok: false, reason: 'host-not-allowlisted' });
    // Suffix tricks do not match the pattern boundary:
    expect(isPeerUrlAllowedForCredentials('https://nottrycloudflare.com').ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials('https://trycloudflare.com.evil.io').ok).toBe(false);
  });

  it('refuses non-http(s) schemes and unparseable URLs', () => {
    expect(isPeerUrlAllowedForCredentials('ftp://10.0.0.1')).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials('not a url')).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('operator-extended suffixes allow custom tunnel domains (the config lever)', () => {
    expect(isPeerUrlAllowedForCredentials('https://mesh.acme-corp.io', ['acme-corp.io']).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('https://mesh.acme-corp.io', ['*.acme-corp.io']).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('https://acme-corp.io.evil.io', ['acme-corp.io']).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials('https://mesh.acme-corp.io', []).ok).toBe(false);
  });

  it('allows .local mDNS names over https', () => {
    expect(isPeerUrlAllowedForCredentials('https://mac-mini.local:4042').ok).toBe(true);
  });

  it('IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10) get LAN trust', () => {
    expect(isPeerUrlAllowedForCredentials('http://[::1]:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://[fd00::1]:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://[fc12:3456::9]:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('http://[fe80::abcd]:4042').ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials('https://[fd00::1]:4042').ok).toBe(true);
  });

  it('IPv6: GLOBAL addresses are refused like any public host', () => {
    expect(isPeerUrlAllowedForCredentials('http://[2001:db8::1]:4042')).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials('https://[2001:db8::1]:4042')).toEqual({ ok: false, reason: 'host-not-allowlisted' });
    expect(isPeerUrlAllowedForCredentials('https://[2607:f8b0::1]:4042').ok).toBe(false);
    // Prefix lookalikes outside the ranges:
    expect(isPeerUrlAllowedForCredentials('https://[feff::1]:4042').ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials('https://[fb00::1]:4042').ok).toBe(false);
  });
});
