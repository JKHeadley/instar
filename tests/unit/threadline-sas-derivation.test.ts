/**
 * Unit tests — Secure A2A Verified Pairing: SAS derivation foundation.
 * Spec: docs/specs/secure-a2a-verified-pairing.md (FD1–FD4).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  deriveSAS,
  deriveSasBits,
  deriveSasFingerprint,
  derivePairingId,
  loadSasWordlist,
  SAS_WORDLIST_SHA256,
} from '../../src/threadline/ThreadlineCrypto.js';

const secret = crypto.createHash('sha256').update('shared-secret-fixture').digest();
const otherSecret = crypto.createHash('sha256').update('different-secret').digest();
const idA = crypto.createHash('sha256').update('identity-A').digest();
const idB = crypto.createHash('sha256').update('identity-B').digest();

describe('SAS wordlist (FD1)', () => {
  it('loads exactly 2048 BIP-39 English words with the pinned hash', () => {
    const w = loadSasWordlist();
    expect(w).toHaveLength(2048);
    expect(w[0]).toBe('abandon');
    const sha = crypto.createHash('sha256').update(w.join('\n')).digest('hex');
    expect(sha).toBe(SAS_WORDLIST_SHA256);
  });
});

describe('deriveSAS (FD2) — determinism + identity-key order-independence', () => {
  it('produces a 6-word SAS, all from the wordlist', () => {
    const sas = deriveSAS(secret, idA, idB);
    expect(sas).toHaveLength(6);
    const words = loadSasWordlist();
    for (const w of sas) expect(words).toContain(w);
  });

  it('is identical for both sides regardless of identity-key argument order', () => {
    // Side A computes deriveSAS(secret, idA, idB); side B computes deriveSAS(secret, idB, idA).
    expect(deriveSAS(secret, idA, idB)).toEqual(deriveSAS(secret, idB, idA));
  });

  it('is deterministic for the same inputs', () => {
    expect(deriveSAS(secret, idA, idB)).toEqual(deriveSAS(secret, idA, idB));
  });

  it('differs for a different shared secret (MITM yields a different SAS)', () => {
    expect(deriveSAS(secret, idA, idB)).not.toEqual(deriveSAS(otherSecret, idA, idB));
  });
});

describe('deriveSasFingerprint (FD3)', () => {
  it('is 16 hex chars (8 bytes), deterministic, and changes with the bits', () => {
    const bitsAB = deriveSasBits(secret, idA, idB);
    const fp = deriveSasFingerprint(bitsAB);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveSasFingerprint(bitsAB)).toBe(fp);
    const bitsOther = deriveSasBits(otherSecret, idA, idB);
    expect(deriveSasFingerprint(bitsOther)).not.toBe(fp);
  });

  it('is order-independent (matches the order-independent SAS bits)', () => {
    expect(deriveSasFingerprint(deriveSasBits(secret, idA, idB)))
      .toBe(deriveSasFingerprint(deriveSasBits(secret, idB, idA)));
  });
});

describe('derivePairingId (FD4) — epoch binding', () => {
  it('is 32 hex chars (16 bytes), deterministic + order-independent', () => {
    const pid = derivePairingId(secret, idA, idB);
    expect(pid).toMatch(/^[0-9a-f]{32}$/);
    expect(derivePairingId(secret, idA, idB)).toBe(pid);
    expect(derivePairingId(secret, idB, idA)).toBe(pid);
  });

  it('differs per handshake instance (different shared secret → different pairingId)', () => {
    expect(derivePairingId(secret, idA, idB)).not.toBe(derivePairingId(otherSecret, idA, idB));
  });

  it('is domain-separated from the SAS fingerprint', () => {
    const pid = derivePairingId(secret, idA, idB);
    const fp = deriveSasFingerprint(deriveSasBits(secret, idA, idB));
    expect(pid).not.toBe(fp);
  });
});
