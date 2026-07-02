/**
 * U4.4 R-r2-1 — the consent-authorized acquisition branch of FencedLease.canAcquire.
 *
 * `held-by-live-peer` is EXACTLY the hand-back state (the holder is alive and
 * CONSENTING, not stale), so a claim is granted ONLY on a holder-signed,
 * epoch-bound, TTL-bounded, SINGLE-USE consent token naming THIS machine.
 * FAIL-CLOSED default: absent / invalid / expired / replayed / reused /
 * wrong-target / wrong-epoch / forged token ⇒ the legacy refusal, unchanged.
 * Uses REAL Ed25519 keys so the signature path is exercised end-to-end.
 *
 * Also covers the U4.4 `handback-offer` MeshCommand RBAC (holder-only,
 * default-deny, its own 403 refusal reason).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { FencedLease, type LeaseCrypto, type HandbackConsentToken } from '../../src/core/FencedLease.js';
import { checkCommandRBAC, type MeshCommand, type RbacDeps } from '../../src/core/MeshRpc.js';
import type { LeaseRecord } from '../../src/core/types.js';

function genKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function makeCrypto(selfMachineId: string, keys: Record<string, { publicKey: string; privateKey: string }>): LeaseCrypto {
  return {
    selfMachineId,
    sign: (canonical: string) => crypto.sign(null, Buffer.from(canonical), keys[selfMachineId].privateKey).toString('base64'),
    verify(canonical: string, signature: string, holderMachineId: string): boolean {
      const pub = keys[holderMachineId]?.publicKey;
      if (!pub) return false;
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
const keys = { HOLDER: genKey(), CAPTAIN: genKey(), MALLORY: genKey() };
const flHolder = () => new FencedLease(makeCrypto('HOLDER', keys), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
const flCaptain = () => new FencedLease(makeCrypto('CAPTAIN', keys), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });
const flMallory = () => new FencedLease(makeCrypto('MALLORY', keys), { leaseTtlMs: TTL, failoverThresholdMs: FAILOVER });

/** A LIVE lease held by HOLDER at epoch 7 (freshly renewed — never expired). */
function liveLease(now: number): LeaseRecord {
  return flHolder().buildAcquisition({ ...flHolder().buildAcquisition(undefined, now, 1), epoch: 6 } as LeaseRecord, now, 2);
}

function mint(fl: FencedLease, epoch: number, target: string, expiresAt: string, nonce = 1): HandbackConsentToken {
  return fl.signHandbackConsent(epoch, target, expiresAt, nonce);
}

describe('FencedLease — hand-back consent token (mint + verify)', () => {
  it('a holder-minted token verifies; a forged signature never does', () => {
    const t = mint(flHolder(), 7, 'CAPTAIN', new Date(100_000).toISOString());
    expect(flCaptain().verifyHandbackConsent(t)).toBe(true);
    // Mallory mints a token CLAIMING to be from HOLDER — the registered-key
    // verify rejects it (an unknown/forged holder never verifies).
    const forged = { ...mint(flMallory(), 7, 'MALLORY', new Date(100_000).toISOString()), holder: 'HOLDER' };
    expect(flCaptain().verifyHandbackConsent(forged)).toBe(false);
    // Field tampering breaks the signature.
    expect(flCaptain().verifyHandbackConsent({ ...t, target: 'MALLORY' })).toBe(false);
    expect(flCaptain().verifyHandbackConsent({ ...t, epoch: 8 })).toBe(false);
  });

  it('the canonical form is discriminator-prefixed (a consent token can never verify as a lease)', () => {
    expect(FencedLease.canonicalizeHandbackConsent({ holder: 'H', epoch: 1, target: 'T', expiresAt: 'x', nonce: 1 })).toContain('handback-consent');
  });
});

describe('FencedLease.canAcquire — the consent branch (fail-closed on every axis)', () => {
  const NOW = 10_000;
  const lease = liveLease(NOW); // HOLDER holds at a live epoch
  const exp = new Date(NOW + 30_000).toISOString();
  const captain = flCaptain();

  it('a VALID token grants acquisition against a live healthy holder', () => {
    const token = mint(flHolder(), lease.epoch, 'CAPTAIN', exp);
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: false });
    expect(d.can).toBe(true);
    expect(d.reason).toContain('handback-consent');
  });

  it('NO opts (the default path) stays the legacy held-by-live-peer refusal, byte-for-byte', () => {
    const d = captain.canAcquire(lease, new Set(), NOW);
    expect(d.can).toBe(false);
    expect(d.reason).toBe('held-by-live-peer (HOLDER)');
  });

  it('an EXPIRED token is refused (TTL-bounded)', () => {
    const token = mint(flHolder(), lease.epoch, 'CAPTAIN', new Date(NOW - 1).toISOString());
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: false });
    expect(d.can).toBe(false);
    expect(d.reason).toBe('held-by-live-peer (HOLDER)');
  });

  it('a REPLAYED/REUSED token is refused (single-use — alreadyUsed)', () => {
    const token = mint(flHolder(), lease.epoch, 'CAPTAIN', exp);
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: true });
    expect(d.can).toBe(false);
  });

  it('a token naming ANOTHER target is refused (target-bound)', () => {
    const token = mint(flHolder(), lease.epoch, 'MALLORY', exp);
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: false });
    expect(d.can).toBe(false);
  });

  it('a token bound to an OLDER epoch is dead the moment the lease moves (epoch-bound)', () => {
    const token = mint(flHolder(), lease.epoch - 1, 'CAPTAIN', exp);
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: false });
    expect(d.can).toBe(false);
  });

  it("a token from a machine that is NOT the live lease's holder is refused", () => {
    // MALLORY signs a (valid-signature) token, but the live lease names HOLDER.
    const token = mint(flMallory(), lease.epoch, 'CAPTAIN', exp);
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: false });
    expect(d.can).toBe(false);
  });

  it('a FORGED signature is refused (cryptographic bind)', () => {
    const token = { ...mint(flHolder(), lease.epoch, 'CAPTAIN', exp), signature: 'AAAA' };
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token, alreadyUsed: false });
    expect(d.can).toBe(false);
  });

  it('a malformed token object is refused (never a crash)', () => {
    const d = captain.canAcquire(lease, new Set(), NOW, undefined, { token: {} as HandbackConsentToken, alreadyUsed: false });
    expect(d.can).toBe(false);
  });
});

describe('handback-offer MeshCommand RBAC (R-r2-2 — holder-only, default-deny)', () => {
  const offer: MeshCommand = {
    type: 'handback-offer',
    proposedEpoch: 8,
    consentToken: { holder: 'HOLDER', epoch: 7, target: 'CAPTAIN', expiresAt: 'x', nonce: 1, signature: 's' },
    expiresAt: 'x',
  };
  const deps = (leaseHolder: string | null): RbacDeps =>
    ({ routerHolder: () => leaseHolder, ownerOf: () => null, placementTargetOf: () => null }) as unknown as RbacDeps;

  it('only the CURRENT lease holder may send it', () => {
    expect(checkCommandRBAC(offer, 'HOLDER', deps('HOLDER')).ok).toBe(true);
  });
  it('a non-holder — including the preferred captain itself — is denied with the OWN refusal reason', () => {
    const d = checkCommandRBAC(offer, 'CAPTAIN', deps('HOLDER'));
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('handback-offer-unauthorized');
  });
  it('an unknown lease view denies (default-deny)', () => {
    expect(checkCommandRBAC(offer, 'HOLDER', deps(null)).ok).toBe(false);
  });
});
