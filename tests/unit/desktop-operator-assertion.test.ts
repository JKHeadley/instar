import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  mintDesktopOperatorAssertion,
  verifyDesktopOperatorAssertion,
  type DesktopOperatorAssertion,
} from '../../src/core/DesktopOperatorAssertion.js';

const FRONT = `m_${'a'.repeat(32)}`;
const TARGET = `m_${'b'.repeat(32)}`;
const OTHER = `m_${'c'.repeat(32)}`;
const NOW = 1_800_000_000_000;
const BROWSER_KEY = 'browser-public-key-for-this-session';
const BROWSER_NONCE = '0123456789abcdef0123456789abcdef';
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();

function assertion(): DesktopOperatorAssertion {
  return mintDesktopOperatorAssertion({
    issuerMachineId: FRONT, targetMachineId: TARGET,
    browserPublicKey: BROWSER_KEY, browserNonce: BROWSER_NONCE,
    nowMs: NOW,
    sign: canonical => sign(null, Buffer.from(canonical), keys.privateKey).toString('base64url'),
  });
}

function check(a: DesktopOperatorAssertion, overrides: Record<string, unknown> = {}) {
  return verifyDesktopOperatorAssertion({
    assertion: a, expectedTargetMachineId: TARGET,
    expectedIssuerMachineId: FRONT, browserPublicKey: BROWSER_KEY,
    browserNonce: BROWSER_NONCE, nowMs: NOW + 1_000,
    resolveIssuerKey: () => publicKey,
    verifySignature: (canonical, signature, pem) => verify(null, Buffer.from(canonical), pem, Buffer.from(signature, 'base64url')),
    seenJti: () => false,
    ...overrides,
  });
}

describe('desktop operator assertion', () => {
  it('accepts one signed, target-bound, browser-bound assertion before expiry', () => {
    const a = assertion();
    expect(check(a)).toEqual({ ok: true, jti: a.jti });
  });

  it('rejects another target, another authenticated peer, and another browser', () => {
    const a = assertion();
    expect(check(a, { expectedTargetMachineId: OTHER })).toEqual({ ok: false, reason: 'wrong-target' });
    expect(check(a, { expectedIssuerMachineId: OTHER })).toEqual({ ok: false, reason: 'wrong-issuer' });
    expect(check(a, { browserPublicKey: 'other-browser' })).toEqual({ ok: false, reason: 'wrong-browser' });
    expect(check(a, { browserNonce: 'other-browser-nonce' })).toEqual({ ok: false, reason: 'wrong-browser' });
  });

  it('rejects expiry, future issuance, stretched lifetime, and replay', () => {
    const a = assertion();
    expect(check(a, { nowMs: a.expiresAtMs })).toEqual({ ok: false, reason: 'expired' });
    expect(check(a, { nowMs: a.issuedAtMs - 2_001 })).toEqual({ ok: false, reason: 'not-yet-valid' });
    expect(check({ ...a, expiresAtMs: a.expiresAtMs + 1 })).toEqual({ ok: false, reason: 'ttl-invalid' });
    expect(check(a, { seenJti: () => true })).toEqual({ ok: false, reason: 'replayed' });
  });

  it('rejects an unknown signer, changed signature, and malformed fields', () => {
    const a = assertion();
    expect(check(a, { resolveIssuerKey: () => null })).toEqual({ ok: false, reason: 'unknown-issuer' });
    expect(check({ ...a, browserNonce: 'other-browser-nonce' }, { browserNonce: 'other-browser-nonce' }))
      .toEqual({ ok: false, reason: 'signature-invalid' });
    expect(check({ ...a, jti: 'short' })).toEqual({ ok: false, reason: 'malformed' });
  });
});
