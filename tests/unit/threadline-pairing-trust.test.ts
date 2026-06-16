/**
 * Unit tests — Secure A2A Verified Pairing, Increment 2 (trust-source + gate).
 *
 * Covers (spec §3.2/§3.3/§3.7, FD4/FD6/FD8/FD12, and the §6 unit-test list):
 *  - markMutualVerified is the SOLE writer of trustSource='mutual-verified'
 *  - the generic setter REJECTS source 'mutual-verified' (returns false)
 *  - unknown/forward-incompat source degrades to un-verified (never elevated)
 *  - credential-share allowed IFF mutual-verified + level>=trusted (both sides)
 *  - a new pairingId resets pairingState + clears prior verifiedAt/peerAcked
 *  - self-pair (peerFp === ownFp) rejected
 *  - the machine-local pending SAS store round-trips + is discarded on transition
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AgentTrustManager,
  CREDENTIAL_SHARE_OP,
  type AgentTrustSource,
} from '../../src/threadline/AgentTrustManager.js';
import { PairingPendingStore } from '../../src/threadline/PairingPendingStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-trust-test-'));
  return {
    dir,
    cleanup: () => SafeFsExecutor.safeRmSync(dir, {
      recursive: true, force: true, operation: 'tests/unit/threadline-pairing-trust.test.ts',
    }),
  };
}

const OWN_FP = 'own-fp-aaaa';
const PEER_FP = 'peer-fp-bbbb';
const PEER_PUB = 'cc'.repeat(32); // 64 hex chars
const SAS_WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent'];
const SAS_FP = 'deadbeefdeadbeef';
const PAIRING_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function recordPending(
  manager: AgentTrustManager,
  overrides: Partial<{ pairingId: string; peerFp: string; peerIdentityPub: string; sasWords: string[]; sasFingerprint: string }> = {},
): boolean {
  return manager.recordPendingVerification(overrides.peerFp ?? PEER_FP, {
    pairingId: overrides.pairingId ?? PAIRING_ID,
    peerIdentityPub: overrides.peerIdentityPub ?? PEER_PUB,
    sasWords: overrides.sasWords ?? SAS_WORDS,
    sasFingerprint: overrides.sasFingerprint ?? SAS_FP,
    ownFp: OWN_FP,
    displayName: 'Dawn',
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Verified Pairing — trust source single-writer', () => {
  let temp: ReturnType<typeof createTempDir>;
  let manager: AgentTrustManager;

  beforeEach(() => {
    temp = createTempDir();
    manager = new AgentTrustManager({ stateDir: temp.dir });
  });

  afterEach(() => {
    manager.flush();
    temp.cleanup();
  });

  describe('markMutualVerified is the sole writer of mutual-verified', () => {
    it('sets source=mutual-verified and raises level to trusted', () => {
      expect(recordPending(manager)).toBe(true);
      const ok = manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      expect(ok).toBe(true);

      const profile = manager.getProfileByFingerprint(PEER_FP)!;
      expect(profile.source).toBe('mutual-verified');
      expect(profile.level).toBe('trusted');
      expect(profile.pairingState).toBe('mutual-verified');
      expect(profile.verifiedAt).toBeDefined();
    });

    it('never raises level above trusted (FD6)', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      const profile = manager.getProfileByFingerprint(PEER_FP)!;
      expect(profile.level).toBe('trusted'); // not autonomous
    });

    it('requires operatorConfirm truthy', () => {
      recordPending(manager);
      const ok = manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: false, ownFp: OWN_FP });
      expect(ok).toBe(false);
      expect(manager.getProfileByFingerprint(PEER_FP)!.source).not.toBe('mutual-verified');
    });

    it('rejects a stale pairingId (epoch binding, FD4)', () => {
      recordPending(manager);
      const ok = manager.markMutualVerified(PEER_FP, { pairingId: 'STALE-ID', operatorConfirm: true, ownFp: OWN_FP });
      expect(ok).toBe(false);
      expect(manager.getProfileByFingerprint(PEER_FP)!.pairingState).toBe('pending-verification');
    });

    it('rejects when there is no pending pairing for the peer', () => {
      const ok = manager.markMutualVerified('unknown-peer', { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      expect(ok).toBe(false);
    });

    it('records optional peerAcked liveness flag when provided', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, peerAcked: true, ownFp: OWN_FP });
      expect(manager.getProfileByFingerprint(PEER_FP)!.peerAcked).toBe(true);
    });

    it('does not require peerAcked (FD8 — local human verify is the bar)', () => {
      recordPending(manager);
      const ok = manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      expect(ok).toBe(true);
      expect(manager.getProfileByFingerprint(PEER_FP)!.peerAcked).toBeUndefined();
    });
  });

  describe('generic setter REJECTS source mutual-verified', () => {
    it('setTrustLevelByFingerprint rejects source=mutual-verified', () => {
      manager.getOrCreateProfileByFingerprint(PEER_FP, 'Dawn');
      const ok = manager.setTrustLevelByFingerprint(
        PEER_FP, 'trusted', 'mutual-verified' as AgentTrustSource, 'self-grant attempt',
      );
      expect(ok).toBe(false);
      const profile = manager.getProfileByFingerprint(PEER_FP)!;
      expect(profile.source).not.toBe('mutual-verified');
    });

    it('setTrustLevel (by name) rejects source=mutual-verified', () => {
      const ok = manager.setTrustLevel('SomeAgent', 'trusted', 'mutual-verified' as AgentTrustSource);
      expect(ok).toBe(false);
    });

    it('credential-share is NOT opened via the generic trusted path', () => {
      // Legitimately user-granted to trusted, but NOT mutual-verified.
      manager.getOrCreateProfileByFingerprint(PEER_FP, 'Dawn');
      manager.setTrustLevelByFingerprint(PEER_FP, 'trusted', 'user-granted');
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
    });
  });

  describe('unknown source degrades to un-verified (never elevated)', () => {
    it('rejects an unrecognized source value as an upgrade input', () => {
      manager.getOrCreateProfileByFingerprint(PEER_FP, 'Dawn'); // starts 'verified'
      const ok = manager.setTrustLevelByFingerprint(
        PEER_FP, 'trusted', 'some-future-source' as AgentTrustSource,
      );
      expect(ok).toBe(false);
      expect(manager.getTrustLevelByFingerprint(PEER_FP)).toBe('verified'); // unchanged
    });

    it('rejects an unknown source even for a same-level set', () => {
      manager.getOrCreateProfileByFingerprint(PEER_FP, 'Dawn');
      const ok = manager.setTrustLevelByFingerprint(
        PEER_FP, 'verified', 'rolled-back-binary-source' as AgentTrustSource,
      );
      expect(ok).toBe(false);
    });
  });

  describe('credential-share allowed IFF mutual-verified + trusted', () => {
    it('TRUE for mutual-verified + trusted', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(true);
      expect(manager.getAllowedOperationsByFingerprint(PEER_FP)).toContain(CREDENTIAL_SHARE_OP);
      // checkPermission via the profile key (fingerprint-keyed profile)
      expect(manager.checkPermission(PEER_FP, CREDENTIAL_SHARE_OP)).toBe(true);
    });

    it('FALSE for a pending-verification (not yet confirmed) peer', () => {
      recordPending(manager);
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
      expect(manager.getAllowedOperationsByFingerprint(PEER_FP)).not.toContain(CREDENTIAL_SHARE_OP);
    });

    it('FALSE for an unknown peer', () => {
      expect(manager.isCredentialShareAllowedByFingerprint('nobody')).toBe(false);
      expect(manager.checkPermission('nobody', CREDENTIAL_SHARE_OP)).toBe(false);
    });

    it('FALSE for an autonomous peer that is not mutual-verified', () => {
      manager.getOrCreateProfileByFingerprint(PEER_FP, 'Dawn');
      manager.setTrustLevelByFingerprint(PEER_FP, 'autonomous', 'user-granted');
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
    });

    it('FALSE if mutual-verified source but level falls below trusted (defensive)', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      // Simulate a safety auto-downgrade dropping the level.
      manager.autoDowngrade(PEER_FP, 'circuit breaker');
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
    });
  });

  describe('new pairingId resets pairing state (FD4)', () => {
    it('resets to pending-verification and clears prior verifiedAt/peerAcked', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, peerAcked: true, ownFp: OWN_FP });
      const verified = manager.getProfileByFingerprint(PEER_FP)!;
      expect(verified.pairingState).toBe('mutual-verified');
      expect(verified.verifiedAt).toBeDefined();
      expect(verified.peerAcked).toBe(true);

      // A NEW handshake (new pairingId) arrives.
      const NEW_ID = 'ffeeddccbbaa00112233445566778899';
      recordPending(manager, { pairingId: NEW_ID });
      const reset = manager.getProfileByFingerprint(PEER_FP)!;
      expect(reset.pairingState).toBe('pending-verification');
      expect(reset.pairingId).toBe(NEW_ID);
      expect(reset.verifiedAt).toBeUndefined();
      expect(reset.peerAcked).toBeUndefined();

      // Credential-share is denied again until re-confirmed.
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);

      // The old pairingId can no longer confirm.
      expect(manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP })).toBe(false);
    });
  });

  describe('self-pair rejected (FD12)', () => {
    it('recordPendingVerification rejects peerFp === ownFp', () => {
      const ok = manager.recordPendingVerification(OWN_FP, {
        pairingId: PAIRING_ID,
        peerIdentityPub: PEER_PUB,
        sasWords: SAS_WORDS,
        sasFingerprint: SAS_FP,
        ownFp: OWN_FP,
      });
      expect(ok).toBe(false);
      expect(manager.getProfileByFingerprint(OWN_FP)).toBeNull();
    });

    it('markMutualVerified rejects peerFp === ownFp', () => {
      // Even if a profile somehow exists, the self-guard refuses.
      manager.getOrCreateProfileByFingerprint(OWN_FP, 'Self');
      const ok = manager.markMutualVerified(OWN_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      expect(ok).toBe(false);
    });
  });

  describe('verification-failed', () => {
    it('forces untrusted, clears mutual-verified source, denies credential-share', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(true);

      manager.markVerificationFailed(PEER_FP, 'operator asserted SAS mismatch');
      const profile = manager.getProfileByFingerprint(PEER_FP)!;
      expect(profile.pairingState).toBe('verification-failed');
      expect(profile.level).toBe('untrusted');
      expect(profile.source).not.toBe('mutual-verified');
      expect(manager.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(false);
    });
  });

  describe('persistence', () => {
    it('mutual-verified pairing survives a reload', () => {
      recordPending(manager);
      manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
      manager.flush();

      const manager2 = new AgentTrustManager({ stateDir: temp.dir });
      const profile = manager2.getProfileByFingerprint(PEER_FP)!;
      expect(profile.source).toBe('mutual-verified');
      expect(profile.pairingState).toBe('mutual-verified');
      expect(manager2.isCredentialShareAllowedByFingerprint(PEER_FP)).toBe(true);
      manager2.flush();
    });
  });
});

describe('PairingPendingStore — machine-local SAS store', () => {
  let temp: ReturnType<typeof createTempDir>;

  beforeEach(() => { temp = createTempDir(); });
  afterEach(() => { temp.cleanup(); });

  it('round-trips a pending record (incl. SAS words)', () => {
    const store = new PairingPendingStore({ stateDir: temp.dir });
    store.put({
      pairingId: PAIRING_ID,
      peerFp: PEER_FP,
      peerIdentityPub: PEER_PUB,
      sasWords: SAS_WORDS,
      sasFingerprint: SAS_FP,
      createdAt: new Date().toISOString(),
    });

    const store2 = new PairingPendingStore({ stateDir: temp.dir });
    const got = store2.get(PEER_FP);
    expect(got).not.toBeNull();
    expect(got!.sasWords).toEqual(SAS_WORDS);
    expect(got!.sasFingerprint).toBe(SAS_FP);
    expect(got!.pairingId).toBe(PAIRING_ID);
  });

  it('writes the store file with 0600 permissions', () => {
    const store = new PairingPendingStore({ stateDir: temp.dir });
    store.put({
      pairingId: PAIRING_ID, peerFp: PEER_FP, peerIdentityPub: PEER_PUB,
      sasWords: SAS_WORDS, sasFingerprint: SAS_FP, createdAt: new Date().toISOString(),
    });
    const storePath = path.join(temp.dir, 'threadline', 'pairing-pending.json');
    const mode = fs.statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('discards a record', () => {
    const store = new PairingPendingStore({ stateDir: temp.dir });
    store.put({
      pairingId: PAIRING_ID, peerFp: PEER_FP, peerIdentityPub: PEER_PUB,
      sasWords: SAS_WORDS, sasFingerprint: SAS_FP, createdAt: new Date().toISOString(),
    });
    expect(store.get(PEER_FP)).not.toBeNull();
    store.discard(PEER_FP);
    expect(store.get(PEER_FP)).toBeNull();
  });

  it('is discarded by the manager on transition to mutual-verified', () => {
    const manager = new AgentTrustManager({ stateDir: temp.dir });
    recordPending(manager);
    // Pending SAS is readable while pending.
    expect(manager.getPendingPairing(PEER_FP)).not.toBeNull();
    expect(manager.getPendingPairing(PEER_FP)!.sasWords).toEqual(SAS_WORDS);

    manager.markMutualVerified(PEER_FP, { pairingId: PAIRING_ID, operatorConfirm: true, ownFp: OWN_FP });
    // Discarded once verified — the SAS words no longer exist on disk.
    expect(manager.getPendingPairing(PEER_FP)).toBeNull();
    manager.flush();
  });

  it('is discarded by the manager on verification-failed', () => {
    const manager = new AgentTrustManager({ stateDir: temp.dir });
    recordPending(manager);
    expect(manager.getPendingPairing(PEER_FP)).not.toBeNull();
    manager.markVerificationFailed(PEER_FP, 'mismatch');
    expect(manager.getPendingPairing(PEER_FP)).toBeNull();
    manager.flush();
  });
});
