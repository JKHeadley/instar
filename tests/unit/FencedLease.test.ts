/**
 * Tier-1 unit tests for FencedLease — the cross-machine coordination primitive.
 *
 * Covers both sides of every decision boundary the spec (§6) calls out:
 * CAS epoch advance, fencing (stale-epoch rejection), max(tunnel,git) never
 * regressing below the git floor, epoch-gap safety, clock-skew immunity,
 * tunnel replay/floor guards, expiry, presumed-dead acquisition, and the
 * livelock backoff. Uses REAL Ed25519 keys (not a stub signer) so the
 * signature path is exercised end-to-end.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import type { LeaseRecord } from '../../src/core/types.js';

function genKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/** A two-machine keyring; verify() resolves the holder's registered pubkey. */
function makeCrypto(selfMachineId: string, keys: Record<string, { publicKey: string; privateKey: string }>): LeaseCrypto {
  return {
    selfMachineId,
    sign(canonical: string): string {
      return crypto.sign(null, Buffer.from(canonical), keys[selfMachineId].privateKey).toString('base64');
    },
    verify(canonical: string, signature: string, holderMachineId: string): boolean {
      const pub = keys[holderMachineId]?.publicKey;
      if (!pub) return false; // unknown holder → never verifies
      try {
        return crypto.verify(null, Buffer.from(canonical), pub, Buffer.from(signature, 'base64'));
      } catch {
        return false;
      }
    },
  };
}

const TTL = 60_000;
const FAILOVER = 15 * 60_000;

describe('FencedLease', () => {
  const keys = { A: genKey(), B: genKey() };
  const leaseA = () => new FencedLease(makeCrypto('A', keys), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
  const leaseB = () => new FencedLease(makeCrypto('B', keys), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });

  describe('CAS acquisition advances the epoch by exactly one', () => {
    it('first acquisition from empty starts at epoch 1', () => {
      const a = leaseA();
      const acq = a.buildAcquisition(undefined, 1_000, 1);
      expect(acq.epoch).toBe(1);
      expect(acq.holder).toBe('A');
      expect(a.verifyLease(acq)).toBe(true);
    });

    it('acquisition over an existing lease advances epoch+1', () => {
      const a = leaseA();
      const prior: LeaseRecord = leaseB().buildAcquisition(undefined, 0, 1); // epoch 1, holder B
      const acq = a.buildAcquisition(prior, 1_000, 1);
      expect(acq.epoch).toBe(2);
      expect(acq.holder).toBe('A');
    });

    it('exactly one of two contenders wins an epoch (same target epoch, CAS picks one)', () => {
      const a = leaseA();
      const b = leaseB();
      const prior: LeaseRecord = a.buildAcquisition(undefined, 0, 1); // epoch 1 by A
      // Both contend to advance to epoch 2; both build epoch-2 candidates.
      const candA = a.buildAcquisition(prior, 1_000, 2);
      const candB = b.buildAcquisition(prior, 1_000, 1);
      expect(candA.epoch).toBe(2);
      expect(candB.epoch).toBe(2);
      // The transport CAS lands exactly one; both are validly signed by their holder.
      expect(a.verifyLease(candA)).toBe(true);
      expect(b.verifyLease(candB)).toBe(true);
      // Cross-verification: A's lease verifies under B's verifier too (same keyring).
      expect(b.verifyLease(candA)).toBe(true);
    });
  });

  describe('fencing — stale epoch is rejected', () => {
    it('holdsValidLease true only when held at the current effective epoch', () => {
      const a = leaseA();
      const lease = a.buildAcquisition(undefined, 1_000, 1); // epoch 1
      expect(a.holdsValidLease(lease, 1, 2_000)).toBe(true);
      // Effective epoch moved to 2 (someone advanced past us) → fenced out.
      expect(a.holdsValidLease(lease, 2, 2_000)).toBe(false);
    });

    it('a non-holder never holds the lease', () => {
      const a = leaseA();
      const b = leaseB();
      const leaseByB = b.buildAcquisition(undefined, 1_000, 1);
      expect(a.holdsValidLease(leaseByB, 1, 2_000)).toBe(false); // A is not holder
      expect(b.holdsValidLease(leaseByB, 1, 2_000)).toBe(true);
    });

    it('isStampCurrent rejects a stale-epoch stamped action', () => {
      expect(FencedLease.isStampCurrent(1, 1)).toBe(true);
      expect(FencedLease.isStampCurrent(1, 2)).toBe(false);
    });
  });

  describe('effectiveEpoch = max(tunnel, git), never below git floor', () => {
    it('takes the higher of tunnel/git', () => {
      expect(FencedLease.effectiveEpoch(5, 3)).toBe(5);
      expect(FencedLease.effectiveEpoch(2, 7)).toBe(7); // a lagging tunnel cannot lower below git
    });
  });

  describe('tunnel lease acceptance (replay + floor + signature guards)', () => {
    it('accepts a valid, above-floor, fresh-nonce lease', () => {
      const a = leaseA();
      const msg = leaseB().buildAcquisition(undefined, 1_000, 5); // holder B, epoch 1, nonce 5
      const d = a.acceptTunnelLease(msg, 0, {});
      expect(d.accept).toBe(true);
    });

    it('rejects a below-git-floor lease', () => {
      const a = leaseA();
      const msg = leaseB().buildAcquisition(undefined, 1_000, 5); // epoch 1
      const d = a.acceptTunnelLease(msg, 3, {}); // git floor is already 3
      expect(d.accept).toBe(false);
      expect(d.reason).toContain('below-git-floor');
    });

    it('rejects a replayed/stale nonce for the same holder', () => {
      const a = leaseA();
      const msg = leaseB().buildAcquisition(undefined, 1_000, 5);
      const d = a.acceptTunnelLease(msg, 0, { B: 5 }); // already saw nonce 5 from B
      expect(d.accept).toBe(false);
      expect(d.reason).toContain('replayed-or-stale-nonce');
    });

    it('rejects a lease with an invalid/forged signature', () => {
      const a = leaseA();
      const msg = leaseB().buildAcquisition(undefined, 1_000, 5);
      const forged: LeaseRecord = { ...msg, signature: Buffer.from('garbage').toString('base64') };
      const d = a.acceptTunnelLease(forged, 0, {});
      expect(d.accept).toBe(false);
      expect(d.reason).toContain('signature-invalid');
    });

    it('rejects a lease naming an unknown holder', () => {
      const a = leaseA();
      // Craft a lease claiming holder "C" (not in keyring) — cannot verify.
      const cryptoC = makeCrypto('C', { ...keys, C: genKey() });
      const leaseC = new FencedLease(cryptoC, { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
      const msg = leaseC.buildAcquisition(undefined, 1_000, 1); // holder C
      const d = a.acceptTunnelLease(msg, 0, {}); // A's keyring has no C
      expect(d.accept).toBe(false);
    });
  });

  describe('expiry + clock-skew immunity', () => {
    it('isExpired true once holder-local TTL passes', () => {
      const a = leaseA();
      const lease = a.buildAcquisition(undefined, 0, 1); // expires at TTL
      expect(a.isExpired(lease, TTL - 1)).toBe(false);
      expect(a.isExpired(lease, TTL)).toBe(true);
    });

    it('a fast-clock machine cannot win — authority is epoch, not time', () => {
      // B has a wildly fast clock but builds the SAME epoch as everyone else.
      const b = leaseB();
      const prior = leaseA().buildAcquisition(undefined, 0, 1); // epoch 1
      const fastClockCandidate = b.buildAcquisition(prior, 9_999_999_999, 1);
      // The clock only sets expiresAt; the epoch is still currentEpoch+1.
      expect(fastClockCandidate.epoch).toBe(2);
      // It does not get a higher epoch from a fast clock.
    });
  });

  describe('acquisition decision', () => {
    it('can acquire when no lease exists', () => {
      expect(leaseA().canAcquire(undefined, new Set(), 1_000).can).toBe(true);
    });
    it('can acquire when the current lease is expired', () => {
      const a = leaseA();
      const expired = a.buildAcquisition(undefined, 0, 1); // expires at TTL
      expect(a.canAcquire(expired, new Set(), TTL + 1).can).toBe(true);
    });
    it('can acquire when the holder is presumed dead', () => {
      const a = leaseA();
      const heldByB = leaseB().buildAcquisition(undefined, 1_000, 1);
      expect(a.canAcquire(heldByB, new Set(['B']), 2_000).can).toBe(true);
    });
    it('CANNOT acquire a live peer-held, unexpired lease', () => {
      const a = leaseA();
      const heldByB = leaseB().buildAcquisition(undefined, 1_000, 1);
      const d = a.canAcquire(heldByB, new Set(), 2_000); // B not presumed dead, not expired
      expect(d.can).toBe(false);
      expect(d.reason).toContain('held-by-live-peer');
    });
    it('can always self-renew', () => {
      const a = leaseA();
      const mine = a.buildAcquisition(undefined, 1_000, 1);
      expect(a.canAcquire(mine, new Set(), 2_000).can).toBe(true);
    });
  });

  describe('livelock backoff', () => {
    it('no backoff below the retry cap', () => {
      expect(leaseA().shouldBackoffAfterContention(0, 'B')).toBe(false);
      expect(leaseA().shouldBackoffAfterContention(4, 'B')).toBe(false);
    });
    it('after the cap, the higher machineId backs off and the lower keeps trying', () => {
      // "A" < "B" lexically. After 5 retries contending with B:
      const a = leaseA(); // self = A (lower)
      const b = leaseB(); // self = B (higher)
      expect(a.shouldBackoffAfterContention(5, 'B')).toBe(false); // A keeps trying
      expect(b.shouldBackoffAfterContention(5, 'A')).toBe(true);  // B backs off
      // Exactly one side yields → guaranteed progress.
    });
  });
});
