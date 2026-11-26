/**
 * Tier-1 — peerUrlGuard: the https/allowlist check a pool fan-out must pass
 * BEFORE attaching the Bearer token to a peer URL
 * (GUARD-POSTURE-ENDPOINT-SPEC §3(c)).
 *
 * Plus the regression surface of peer-credential-guard-tailscale-coherence:
 * the guard now takes a TYPED selection with a REQUIRED kind, composes the
 * shared range predicates instead of a third hand-written copy, and names the
 * Tailscale-CGNAT refusal accurately instead of the misleading
 * `scheme-not-allowed`.
 */
import { describe, expect, it } from 'vitest';
import {
  isPeerUrlAllowedForCredentials,
  type PeerEndpointKind,
} from '../../src/server/peerUrlGuard.js';
import { isRfc1918, isTailscaleCgnat } from '../../src/core/PeerEndpointResolver.js';

const ALL_KINDS: PeerEndpointKind[] = ['tailscale', 'lan', 'cloudflare', 'last-known-url'];

/** A selection whose kind is irrelevant to the assertion under test. */
function sel(url: string, kind: PeerEndpointKind = 'last-known-url') {
  return { url, kind };
}

describe('isPeerUrlAllowedForCredentials', () => {
  it('allows known tunnel domains over https', () => {
    expect(isPeerUrlAllowedForCredentials(sel('https://abc-def.trycloudflare.com', 'cloudflare')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('https://echo.dawn-tunnel.dev', 'cloudflare')).ok).toBe(true);
  });

  it('allows localhost + RFC-1918 hosts (http permitted inside the LAN)', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://localhost:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://127.0.0.1:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://10.0.0.5:4042', 'lan')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://192.168.1.20:4042', 'lan')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://172.16.0.9:4042', 'lan')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://172.31.255.1:4042', 'lan')).ok).toBe(true);
  });

  it('refuses 172.x outside the private /12 and any public http host', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://172.15.0.1:4042'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials(sel('http://172.32.0.1:4042'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials(sel('http://example.com'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
  });

  it('refuses https hosts outside the allowlist — the token never travels there', () => {
    expect(isPeerUrlAllowedForCredentials(sel('https://evil.example.com'))).toEqual({ ok: false, reason: 'host-not-allowlisted' });
    expect(isPeerUrlAllowedForCredentials(sel('https://nottrycloudflare.com')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('https://trycloudflare.com.evil.io')).ok).toBe(false);
  });

  it('refuses non-http(s) schemes and unparseable URLs', () => {
    expect(isPeerUrlAllowedForCredentials(sel('ftp://10.0.0.1'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials(sel('not a url'))).toEqual({ ok: false, reason: 'invalid-url' });
  });

  it('operator-extended suffixes allow custom tunnel domains (the config lever)', () => {
    expect(isPeerUrlAllowedForCredentials(sel('https://mesh.acme-corp.io'), ['acme-corp.io']).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('https://mesh.acme-corp.io'), ['*.acme-corp.io']).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('https://acme-corp.io.evil.io'), ['acme-corp.io']).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('https://mesh.acme-corp.io'), []).ok).toBe(false);
  });

  it('allows .local mDNS names over https', () => {
    expect(isPeerUrlAllowedForCredentials(sel('https://mac-mini.local:4042')).ok).toBe(true);
  });

  // ── The §2 trap: loopback + IPv6 trust must SURVIVE the shared-predicate
  // refactor. The resolver's isForbiddenHost FORBIDS loopback and has no IPv6
  // predicates, so importing it wholesale would regress both. These are the
  // tests that fail if someone "simplifies" the guard by reusing it. ──
  it('TRAP: loopback stays allowed (it is us, not a peer — unlike isForbiddenHost)', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://localhost:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://127.0.0.1:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://127.9.9.9:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://[::1]:4042')).ok).toBe(true);
  });

  it('TRAP: IPv6 unique-local + link-local stay allowed (the resolver has no IPv6 predicates)', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://[fd00::1]:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fc12:3456::9]:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fe80::abcd]:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('https://[fd00::1]:4042')).ok).toBe(true);
  });

  it('IPv6 ULA BOUNDARIES: a short first hextet is OUTSIDE fc00::/7 and must be refused', () => {
    // Pre-existing over-admission found by the second-pass reviewer: the old
    // `/^f[cd][0-9a-f]{0,2}:/` matched these, whose first hextets are 0x00fc,
    // 0x0fd0 and 0x000f — none inside fc00..fdff.
    expect(isPeerUrlAllowedForCredentials(sel('http://[fc::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fd::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fc0::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fd0::1]:4042')).ok).toBe(false);
    // ...while the genuine range still passes, both ends.
    expect(isPeerUrlAllowedForCredentials(sel('http://[fc00::1]:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fdff:ffff::1]:4042')).ok).toBe(true);
  });

  it('IPv6 link-local BOUNDARIES: fe80..febf only', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://[fe80::1]:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://[febf::1]:4042')).ok).toBe(true);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fe7f::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fec0::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('http://[fe8::1]:4042')).ok).toBe(false);
  });

  it('IPv6: GLOBAL addresses are refused like any public host', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://[2001:db8::1]:4042'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials(sel('https://[2001:db8::1]:4042'))).toEqual({ ok: false, reason: 'host-not-allowlisted' });
    expect(isPeerUrlAllowedForCredentials(sel('https://[2607:f8b0::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('https://[feff::1]:4042')).ok).toBe(false);
    expect(isPeerUrlAllowedForCredentials(sel('https://[fb00::1]:4042')).ok).toBe(false);
  });

  // ── Tailscale CGNAT: refused DELIBERATELY, and named accurately ──
  it('names the CGNAT refusal accurately instead of the misleading scheme-not-allowed', () => {
    // These are the exact live-registry addresses that produced the reported defect.
    expect(isPeerUrlAllowedForCredentials(sel('http://100.124.55.70:4042', 'tailscale'))).toEqual({
      ok: false,
      reason: 'cgnat-plaintext-unsupported',
    });
    expect(isPeerUrlAllowedForCredentials(sel('http://100.64.165.27:4042', 'tailscale'))).toEqual({
      ok: false,
      reason: 'cgnat-plaintext-unsupported',
    });
  });

  it('NO ADMISSION PATH: no kind, suffix or scheme combination admits a CGNAT host over http', () => {
    const cgnatHosts = [
      'http://100.64.0.0:4042',
      'http://100.64.0.1:4042',
      'http://100.100.100.100:4042',
      'http://100.127.255.255:4042',
    ];
    const suffixSets: (readonly string[] | undefined)[] = [
      undefined,
      [],
      ['dawn-tunnel.dev'],
      ['100.64.0.1'],
      ['*'],
    ];
    for (const url of cgnatHosts) {
      for (const kind of ALL_KINDS) {
        for (const suffixes of suffixSets) {
          const verdict = isPeerUrlAllowedForCredentials({ url, kind }, suffixes);
          expect(verdict.ok, `${url} kind=${kind} suffixes=${JSON.stringify(suffixes)}`).toBe(false);
          expect(verdict.reason).toBe('cgnat-plaintext-unsupported');
        }
      }
    }
  });

  it('CGNAT boundaries: 100.63.x and 100.128.x are OUTSIDE the range (ordinary public http refusal)', () => {
    expect(isPeerUrlAllowedForCredentials(sel('http://100.63.255.255:4042'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
    expect(isPeerUrlAllowedForCredentials(sel('http://100.128.0.0:4042'))).toEqual({ ok: false, reason: 'scheme-not-allowed' });
  });

  it('CGNAT over https is allowlist-governed, not CGNAT-refused (the reason is scheme-specific)', () => {
    // https to a CGNAT literal is refused for not being allowlisted — the CGNAT
    // reason is about PLAINTEXT, so it must not leak into the https branch.
    expect(isPeerUrlAllowedForCredentials(sel('https://100.64.0.1:4042'))).toEqual({ ok: false, reason: 'host-not-allowlisted' });
  });

  // ── Anti-divergence: BEHAVIORAL equivalence with the shared predicates.
  // The claim is narrow and deliberate: this detects DIVERGENCE (the harm),
  // not the absence of a duplicate implementation. ──
  describe('anti-divergence: agrees with the shared predicates', () => {
    function expectAgreement(host: string) {
      const verdict = isPeerUrlAllowedForCredentials(sel(`http://${host}:4042`));
      const loopback = host === 'localhost' || /^127\./.test(host);
      if (isRfc1918(host) || loopback) {
        expect(verdict.ok, `${host} should be admitted (isRfc1918/loopback)`).toBe(true);
      } else if (isTailscaleCgnat(host)) {
        expect(verdict.reason, `${host} should be the CGNAT refusal`).toBe('cgnat-plaintext-unsupported');
      } else {
        expect(verdict.ok, `${host} should be refused`).toBe(false);
      }
    }

    it('exhaustive BOUNDARIES either side of every owned range', () => {
      for (const host of [
        // 10/8
        '9.255.255.255', '10.0.0.0', '10.255.255.255', '11.0.0.0',
        // 172.16/12
        '172.15.255.255', '172.16.0.0', '172.31.255.255', '172.32.0.0',
        // 192.168/16
        '192.167.255.255', '192.168.0.0', '192.168.255.255', '192.169.0.0',
        // 100.64/10 (CGNAT)
        '100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0',
        // 127/8 loopback
        '126.255.255.255', '127.0.0.0', '127.255.255.255', '128.0.0.0',
        // 169.254/16 link-local
        '169.253.255.255', '169.254.0.0', '169.254.169.254', '169.255.0.0',
      ]) {
        expectAgreement(host);
      }
    });

    it('INTERIOR addresses (an erroneous exclusion inside a range needs no new range)', () => {
      for (const host of [
        '10.17.42.9', '10.200.3.1',
        '172.20.5.5', '172.28.100.200',
        '192.168.17.42',
        '100.90.1.2', '100.70.200.30',
        '127.5.5.5',
      ]) {
        expectAgreement(host);
      }
    });

    it('PROPERTY sweep over pseudo-random IPv4 space', () => {
      // Deterministic LCG — a fixed seed keeps a failure reproducible.
      let seed = 0x5eed1234;
      const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) >>> 8) & 0xff;
      for (let i = 0; i < 1500; i += 1) {
        expectAgreement(`${next()}.${next()}.${next()}.${next()}`);
      }
    });
  });
});
