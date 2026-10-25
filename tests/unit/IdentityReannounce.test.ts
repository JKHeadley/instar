import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdentityStore } from '../../src/core/IdentityStore.js';
import { evaluateIdentityPoolAgreement, IdentityReannounceService, IssuedRefusalStore, projectProposedIdentity } from '../../src/core/IdentityReannounce.js';
import { MachineRecoveryKey, signingRotationMessage, type RecoverySecretStore, type RotationBinding } from '../../src/core/MachineRecoveryKey.js';
import { generateEncryptionKeyPair, generateSigningKeyPair, pemToBase64, sign } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';

class FakeSecretStore implements RecoverySecretStore {
  values = new Map<string, unknown>();
  isKeychainBacked = true;
  get(k: string): unknown { return this.values.get(k); }
  set(k: string, v: unknown): void { this.values.set(k, v); }
  delete(k: string): void { this.values.delete(k); }
}

describe('IdentityReannounceService', () => {
  let root: string;
  let stateDir: string;
  let now: number;
  let store: IdentityStore;
  let refusals: IssuedRefusalStore;
  let recovery: MachineRecoveryKey;
  let current: MachineIdentity;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reannounce-'));
    stateDir = path.join(root, '.instar');
    now = Date.parse('2026-08-30T12:00:00.000Z');
    store = new IdentityStore({ stateDir, now: () => now });
    refusals = new IssuedRefusalStore({ stateDir, now: () => now });
    recovery = new MachineRecoveryKey(new FakeSecretStore());
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const rec = recovery.ensure('m_peer')!;
    current = {
      machineId: 'm_peer', signingPublicKey: pemToBase64(signing.publicKey), encryptionPublicKey: pemToBase64(encryption.publicKey),
      name: 'peer', platform: 'darwin-arm64', createdAt: new Date(now).toISOString(), capabilities: ['sessions'],
      keyEpoch: 0, recoveryPublicKey: rec.recoveryPublicKey, recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand',
    };
    store.apply({ identity: current, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machines', 'registry.json'), JSON.stringify({
      version: 1,
      machines: { m_peer: { name: 'peer', status: 'active', role: 'standby', pairedAt: 'x', lastSeen: 'x' } },
    }));
    for (let i = 0; i < 10; i++) { refusals.recordSignatureInvalid('m_peer'); now += 100_000; }
  });

  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/IdentityReannounce.test.ts' }));

  function service(dryRun = false): IdentityReannounceService {
    return new IdentityReannounceService({ stateDir, identityStore: store, issuedRefusals: refusals, challengerMachineId: 'm_local', now: () => now, dryRun: () => dryRun });
  }

  function proposed(hasRecovery = true): { identity: MachineIdentity; privateKey: string } {
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    return {
      privateKey: signing.privateKey,
      identity: {
        ...current,
        signingPublicKey: pemToBase64(signing.publicKey),
        encryptionPublicKey: pemToBase64(encryption.publicKey),
        keyEpoch: 1,
        ...(hasRecovery ? {} : { recoveryPublicKey: undefined, recoveryEpoch: 0, recoveryAnchorProvenance: undefined }),
      },
    };
  }

  function signedClaim(svc: IdentityReannounceService, next: MachineIdentity, privateKey: string, continuity = true) {
    const ch = svc.issueChallenge(next, '100.64.0.2');
    const binding: RotationBinding = {
      nonce: ch.nonce, claimantMachineId: next.machineId, newSigningPublicKey: next.signingPublicKey,
      newEncryptionPublicKey: next.encryptionPublicKey, challengerMachineId: 'm_local', keyEpoch: next.keyEpoch!,
      recoveryEpoch: next.recoveryEpoch ?? 0, newRecoveryPublicKey: next.recoveryPublicKey,
    };
    return {
      challengeId: ch.challengeId,
      possessionSignature: sign(signingRotationMessage(binding), privateKey),
      continuitySignature: continuity ? recovery.signContinuity('m_peer', binding)! : undefined,
    };
  }

  const goodContext = {
    sourceVerifiedUnderIncumbent: false,
    recoveryAgreement: 'consistent' as const,
    signingAgreement: 'consistent' as const,
    governorAllowed: true,
    unackedAcceptedRotation: false,
  };

  it('accepts a valid recovery-continuity rotation with zero operator action', () => {
    const svc = service(false);
    const next = proposed();
    const result = svc.evaluate(signedClaim(svc, next.identity, next.privateKey), goodContext);
    expect(result.outcome).toBe('accepted');
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(1);
  });

  it('accepts pinned recovery continuity without requiring an ordinary refusal run', () => {
    refusals = new IssuedRefusalStore({ stateDir: path.join(root, 'empty-refusals'), now: () => now });
    const svc = service(false);
    const next = proposed();
    expect(svc.evaluate(signedClaim(svc, next.identity, next.privateKey), goodContext).outcome).toBe('accepted');
  });

  it('does not treat a root with missing receiver-derived provenance as first-hand authority', () => {
    const identityPath = path.join(stateDir, 'machines', 'm_peer', 'identity.json');
    const seeded = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    delete seeded.recoveryAnchorProvenance;
    fs.writeFileSync(identityPath, JSON.stringify(seeded));
    const svc = service(false);
    const next = proposed();
    const result = svc.evaluate(
      signedClaim(svc, next.identity, next.privateKey),
      { ...goodContext, recoveryAgreement: 'unverifiable' },
    );
    expect(result).toMatchObject({ outcome: 'quarantined', quarantine: { reasons: expect.arrayContaining(['recovery-root-unverifiable']) } });
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
  });

  it('quarantines rather than downgrading when a recovery signature is missing', () => {
    const svc = service(false);
    const next = proposed();
    const result = svc.evaluate(signedClaim(svc, next.identity, next.privateKey, false), { ...goodContext, sourceVerifiedUnderIncumbent: true });
    expect(result.outcome).toBe('quarantined');
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
  });

  it('refuses skipped epochs before quarantine and burns the challenge against replay', () => {
    const svc = service(false);
    const next = proposed();
    next.identity.keyEpoch = 2;
    const claim = signedClaim(svc, next.identity, next.privateKey);
    expect(svc.evaluate(claim, goodContext)).toEqual({ outcome: 'refused', reason: 'key-epoch-not-next' });
    expect(svc.evaluate(claim, goodContext)).toEqual({ outcome: 'refused', reason: 'challenge-replayed' });
  });

  it('allows incumbent-source fallback only when no recovery root is established', () => {
    const noRecovery = { ...current, recoveryPublicKey: undefined, recoveryEpoch: 0, recoveryAnchorProvenance: undefined };
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reannounce-no-recovery-'));
    try {
      const localStore = new IdentityStore({ stateDir: path.join(freshRoot, '.instar'), now: () => now });
      localStore.apply({ identity: noRecovery, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
      fs.mkdirSync(path.join(freshRoot, '.instar', 'machines'), { recursive: true });
      fs.writeFileSync(path.join(freshRoot, '.instar', 'machines', 'registry.json'), JSON.stringify({
        version: 1,
        machines: { m_peer: { name: 'peer', status: 'active', role: 'standby', pairedAt: 'x', lastSeen: 'x' } },
      }));
      const localRefusals = new IssuedRefusalStore({ stateDir: path.join(freshRoot, '.instar'), now: () => now });
      let localNow = now - 1_000_000;
      const ref = new IssuedRefusalStore({ stateDir: path.join(freshRoot, '.instar'), now: () => localNow });
      for (let i = 0; i < 10; i++) { ref.recordSignatureInvalid('m_peer'); localNow += 100_000; }
      const svc = new IdentityReannounceService({ stateDir: path.join(freshRoot, '.instar'), identityStore: localStore, issuedRefusals: localRefusals, challengerMachineId: 'm_local', now: () => localNow, dryRun: () => false });
      const next = proposed(false);
      expect(svc.evaluate(signedClaim(svc, next.identity, next.privateKey, false), { ...goodContext, sourceVerifiedUnderIncumbent: true }))
        .toMatchObject({ outcome: 'quarantined', quarantine: { reasons: ['conflict-settle-window'] } });
      localNow += 10 * 60_000 + 1;
      expect(svc.evaluate(signedClaim(svc, next.identity, next.privateKey, false), { ...goodContext, sourceVerifiedUnderIncumbent: true }))
        .toMatchObject({ outcome: 'accepted' });
    } finally {
      SafeFsExecutor.safeRmSync(freshRoot, { recursive: true, force: true, operation: 'tests/unit/IdentityReannounce.test.ts:no-recovery' });
    }
  });

  it('dry-run records verdicts without mutating identity', () => {
    const svc = service(true);
    const next = proposed();
    expect(svc.evaluate(signedClaim(svc, next.identity, next.privateKey), goodContext).outcome).toBe('would-accept');
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
  });

  it('dry-run exercises the live store invariants before reporting would-accept', () => {
    const svc = service(true);
    const next = proposed();
    next.identity.name = 'claimant-controlled-rename';
    expect(svc.evaluate(signedClaim(svc, next.identity, next.privateKey), goodContext))
      .toEqual({ outcome: 'refused', reason: 'identity-metadata-mutation' });
    expect(store.loadIdentity('m_peer', 'remote')?.name).toBe('peer');
  });

  it('dry-run operator approval cannot mutate trust or acknowledge the pending claim', () => {
    const svc = service(true);
    const next = proposed();
    const evaluated = svc.evaluate(
      signedClaim(svc, next.identity, next.privateKey),
      { ...goodContext, governorAllowed: false },
    );
    expect(evaluated.outcome).toBe('would-quarantine');
    if (evaluated.outcome !== 'would-quarantine') throw new Error('expected quarantine');

    expect(svc.approve(evaluated.quarantine.id, evaluated.quarantine.claimHash)).toMatchObject({
      outcome: 'would-accept',
      claimHash: evaluated.quarantine.claimHash,
    });
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
    expect(store.listUnacknowledged()).toEqual([]);
    expect(svc.status().pending).toHaveLength(1);
  });

  it('refuses a claimant that cannot prove possession of the replacement signing key', () => {
    const svc = service(false);
    const next = proposed();
    const claim = signedClaim(svc, next.identity, next.privateKey);
    claim.possessionSignature = 'not-a-valid-signature';
    expect(svc.evaluate(claim, goodContext)).toEqual({ outcome: 'refused', reason: 'new-key-possession-invalid' });
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
  });

  it('quarantines equal-epoch recovery-root divergence even with a valid continuity proof', () => {
    const svc = service(false);
    const next = proposed();
    const result = svc.evaluate(signedClaim(svc, next.identity, next.privateKey), { ...goodContext, recoveryAgreement: 'divergent' });
    expect(result).toMatchObject({ outcome: 'quarantined', quarantine: { reasons: expect.arrayContaining(['recovery-root-divergent']) } });
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
  });

  it('refuses a first-hand recovery signature when a live peer knows a higher recovery epoch', () => {
    const svc = service(false);
    const next = proposed();
    expect(svc.evaluate(
      signedClaim(svc, next.identity, next.privateKey),
      { ...goodContext, recoveryAgreement: 'below-max' },
    )).toEqual({ outcome: 'refused', reason: 'recovery-root-below-live-peer-maximum' });
    expect(store.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
  });

  it('quarantines a valid cryptographic claim when the self-action governor denies admission', () => {
    const svc = service(false);
    const next = proposed();
    const result = svc.evaluate(signedClaim(svc, next.identity, next.privateKey), { ...goodContext, governorAllowed: false });
    expect(result).toMatchObject({ outcome: 'quarantined', quarantine: { reasons: ['governor-denied'] } });
  });

  it('never resurrects a revoked principal through re-announcement', () => {
    store.revoke('m_peer', 'm_local', 'security removal');
    const svc = service(false);
    const next = proposed();
    expect(() => signedClaim(svc, next.identity, next.privateKey))
      .toThrowError(expect.objectContaining({ code: 'sticky-revocation' }));
  });

  it.each([
    ['missing', undefined, 'registry-unreadable'],
    ['corrupt', '{broken', 'registry-unreadable'],
    ['pending', JSON.stringify({ version: 1, machines: { m_peer: { name: 'peer', status: 'pending', role: 'standby', pairedAt: 'x', lastSeen: 'x' } } }), 'registry-machine-inactive'],
    ['revoked', JSON.stringify({ version: 1, machines: { m_peer: { name: 'peer', status: 'revoked', role: 'standby', pairedAt: 'x', lastSeen: 'x', revokedAt: '2026-01-01T00:00:00Z' } } }), 'sticky-revocation'],
  ])('fails closed when the registry row is %s', (_label, contents, code) => {
    const registryPath = path.join(stateDir, 'machines', 'registry.json');
    if (contents === undefined) SafeFsExecutor.safeUnlinkSync(registryPath, {
      operation: 'IdentityReannounce.test:remove-registry-fixture',
    });
    else fs.writeFileSync(registryPath, contents);
    const next = proposed();
    expect(() => service(false).issueChallenge(next.identity, 'source')).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects traversal-shaped machine identifiers before resolving a path', () => {
    const next = proposed();
    next.identity.machineId = '../m_peer';
    expect(() => service(false).issueChallenge(next.identity, 'source')).toThrowError(expect.objectContaining({ code: 'invalid-machine-id' }));
  });

  it('keeps both conflicting claims quarantined and emits one deduped conflict episode', () => {
    const conflicts: unknown[] = [];
    const svc = new IdentityReannounceService({
      stateDir, identityStore: store, issuedRefusals: refusals, challengerMachineId: 'm_local', now: () => now,
      dryRun: () => false, onConflict: (event) => conflicts.push(event),
    });
    const first = proposed();
    const second = proposed();
    expect(svc.evaluate(signedClaim(svc, first.identity, first.privateKey, false), goodContext).outcome).toBe('quarantined');
    expect(svc.evaluate(signedClaim(svc, second.identity, second.privateKey, false), goodContext).outcome).toBe('quarantined');
    expect(svc.status().pending).toHaveLength(2);
    expect(svc.status().pending.every((row) => row.reasons.includes('conflicting-claim'))).toBe(true);
    expect(conflicts).toHaveLength(1);
  });

  it('does not let the first of two fully valid bare claims win the settle window', () => {
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reannounce-bare-conflict-'));
    try {
      const dir = path.join(freshRoot, '.instar');
      let localNow = now;
      const localStore = new IdentityStore({ stateDir: dir, now: () => localNow });
      const incumbent = { ...current, recoveryPublicKey: undefined, recoveryEpoch: 0, recoveryAnchorProvenance: undefined };
      localStore.apply({ identity: incumbent, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
      fs.mkdirSync(path.join(dir, 'machines'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), JSON.stringify({
        version: 1, machines: { m_peer: { name: 'peer', status: 'active', role: 'standby', pairedAt: 'x', lastSeen: 'x' } },
      }));
      const localRefusals = new IssuedRefusalStore({ stateDir: dir, now: () => localNow });
      for (let i = 0; i < 10; i += 1) { localRefusals.recordSignatureInvalid('m_peer'); localNow += 100_000; }
      const conflicts: unknown[] = [];
      const svc = new IdentityReannounceService({
        stateDir: dir, identityStore: localStore, issuedRefusals: localRefusals, challengerMachineId: 'm_local',
        now: () => localNow, dryRun: () => false, onConflict: (event) => conflicts.push(event),
      });
      const makeBare = () => {
        const signing = generateSigningKeyPair();
        const encryption = generateEncryptionKeyPair();
        const identity: MachineIdentity = {
          ...incumbent, signingPublicKey: pemToBase64(signing.publicKey),
          encryptionPublicKey: pemToBase64(encryption.publicKey), keyEpoch: 1,
        };
        const challenge = svc.issueChallenge(identity, 'incumbent-source');
        const binding: RotationBinding = {
          nonce: challenge.nonce, claimantMachineId: 'm_peer', newSigningPublicKey: identity.signingPublicKey,
          newEncryptionPublicKey: identity.encryptionPublicKey, challengerMachineId: 'm_local', keyEpoch: 1,
          recoveryEpoch: 0,
        };
        return { challengeId: challenge.challengeId, possessionSignature: sign(signingRotationMessage(binding), signing.privateKey) };
      };
      const bareContext = { ...goodContext, sourceVerifiedUnderIncumbent: true };
      expect(svc.evaluate(makeBare(), bareContext).outcome).toBe('quarantined');
      expect(svc.evaluate(makeBare(), bareContext).outcome).toBe('quarantined');
      expect(localStore.loadIdentity('m_peer', 'remote')?.keyEpoch).toBe(0);
      expect(svc.status().pending).toHaveLength(2);
      expect(svc.status().pending.every((row) => row.reasons.includes('conflicting-claim'))).toBe(true);
      expect(conflicts).toHaveLength(1);
    } finally {
      SafeFsExecutor.safeRmSync(freshRoot, { recursive: true, force: true, operation: 'IdentityReannounce bare conflict' });
    }
  });
});

describe('identity pool agreement uses current target-bound projections', () => {
  const projection = (overrides: Partial<import('../../src/core/IdentityStore.js').IdentityProjection> = {}) => ({
    machineId: 'm_peer', keyEpoch: 4, signingFingerprint: 'old-signing',
    recoveryEpoch: 2, recoveryFingerprint: 'recovery-a', recoveryAnchorProvenance: 'first-hand' as const,
    registryStatus: 'active' as const, ...overrides,
  });
  const target = projection({ keyEpoch: 5, signingFingerprint: 'new-signing' });

  it('treats lagging peers with the same incumbent fingerprint as convergence', () => {
    expect(evaluateIdentityPoolAgreement({
      target,
      localCurrent: projection(),
      peers: [projection(), projection({ keyEpoch: 5, signingFingerprint: 'new-signing' })],
    })).toEqual({ recoveryAgreement: 'consistent', signingAgreement: 'consistent' });
  });

  it('detects a different signing fingerprint at the proposed target epoch', () => {
    expect(evaluateIdentityPoolAgreement({
      target,
      localCurrent: projection(),
      peers: [projection({ keyEpoch: 5, signingFingerprint: 'racing-signing' })],
    }).signingAgreement).toBe('divergent');
  });

  it('never calls an older recovery root consistent when a live peer knows a higher epoch', () => {
    expect(evaluateIdentityPoolAgreement({
      target,
      localCurrent: projection(),
      peers: [projection({ recoveryEpoch: 3, recoveryFingerprint: 'recovery-new' })],
    }).recoveryAgreement).toBe('below-max');
  });

  it('detects equal-recovery-epoch fingerprint divergence', () => {
    expect(evaluateIdentityPoolAgreement({
      target,
      localCurrent: projection(),
      peers: [projection({ recoveryFingerprint: 'recovery-poisoned' })],
    }).recoveryAgreement).toBe('divergent');
  });

  it('projects the proposed public keys and epochs rather than an audit row', () => {
    const proposedIdentity = {
      machineId: 'm_peer', signingPublicKey: 'new-public', encryptionPublicKey: 'new-encryption',
      name: 'peer', platform: 'darwin-arm64', createdAt: 'x', capabilities: [], keyEpoch: 5,
      recoveryPublicKey: 'recovery-public', recoveryEpoch: 2, recoveryAnchorProvenance: 'first-hand' as const,
    };
    expect(projectProposedIdentity(proposedIdentity)).toMatchObject({ machineId: 'm_peer', keyEpoch: 5, recoveryEpoch: 2 });
  });
});
