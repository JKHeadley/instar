import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixedSlugRecertified, selectFixedCertificate, signFixedRegistrySnapshot, verifyFixedRegistrySnapshot,
  type FixedCertificateRegistrySnapshot } from '../../src/scheduler/JobFixedCertificateRegistry.js';
import type { MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { JobFixedRegistryReplica } from '../../src/scheduler/JobFixedRegistryReplica.js';
import { JobFixedRegistryAuthorityStore } from '../../src/scheduler/JobFixedRegistryAuthorityStore.js';
import { JobFixedRegistryReader } from '../../src/scheduler/JobFixedRegistryReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { fixedCertificateBody, type FixedResultCertificate } from '../../src/scheduler/JobFixedResultCertificate.js';
import { signFixedRevocationProof, verifyFixedRevocationProof } from '../../src/scheduler/JobFixedRegistryRevocation.js';
import { JobFixedRegistryRevocationDispatcher } from '../../src/scheduler/JobFixedRegistryRevocationDispatcher.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';

const now = Date.parse('2026-11-02T03:30:00.000Z');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signer: MachineSigner = {
  machineId: () => 'm_authority', signerKeyHash: () => 'key-hash',
  sign: payload => ({ machineId: 'm_authority', signerKeyHash: 'key-hash',
    sig: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') }),
};
const lookup = (machineId: string, hash: string) => machineId === 'm_authority' && hash === 'key-hash'
  ? { status: 'ok' as const, publicKeyPem: pem } : { status: 'unknown' as const };
const base = {
  version: 1 as const, authorityMachineId: 'm_authority', epoch: 3,
  issuedAt: new Date(now).toISOString(), certificates: [], activeIds: [], revokedIds: [],
  ownerPublicKeys: {}, reviewerPublicKeys: {}, missEpochs: {},
};
const verify = (snapshot: FixedCertificateRegistrySnapshot, minimumEpoch = 2, at = now + 1000) =>
  verifyFixedRegistrySnapshot(snapshot, { pinnedAuthorityMachineId: 'm_authority',
    keyLookup: lookup, now: at, minimumEpoch });

describe('signed fixed-certificate registry snapshot', () => {
  it('accepts only a machine-signed independently graded false-routine proof', () => {
    const proof = signFixedRevocationProof({ version: 2, sourceMachineId: 'm_authority',
      attemptId: 'attempt-1', certificateId: 'certificate-1', evidenceId: 'independent-grade',
      gradedAt: new Date(now).toISOString(), signedAt: new Date(now + 1000).toISOString(),
      grade: 'incorrect', provider: 'fixed',
      verdict: 'routine' }, signer);
    expect(verifyFixedRevocationProof(proof, lookup, now + 1000)).toBe(true);
    expect(verifyFixedRevocationProof({ ...proof, certificateId: 'other' }, lookup, now + 1000)).toBe(false);
    expect(verifyFixedRevocationProof({ ...proof, sourceMachineId: 'm_other' }, lookup, now + 1000)).toBe(false);
    expect(verifyFixedRevocationProof({ ...proof, signedAt: new Date(now).toISOString() }, lookup, now + 1000)).toBe(false);
    expect(verifyFixedRevocationProof({ ...proof, version: 1 } as unknown as typeof proof,
      lookup, now + 1000)).toBe(false);
  });
  it('checks a delayed proof against the signing key epoch, not its older grade time', () => {
    const gradeAt = now;
    const signedAt = now + 2 * 60 * 60_000;
    const proof = signFixedRevocationProof({ version: 2, sourceMachineId: 'm_authority',
      attemptId: 'rotated-attempt', certificateId: 'rotated-certificate', evidenceId: 'late-grade',
      gradedAt: new Date(gradeAt).toISOString(), signedAt: new Date(signedAt).toISOString(),
      grade: 'incorrect', provider: 'fixed', verdict: 'routine' }, signer);
    const rotatedLookup = (machineId: string, hash: string, at: number) =>
      machineId === 'm_authority' && hash === 'key-hash' && at >= signedAt
        ? { status: 'ok' as const, publicKeyPem: pem } : { status: 'unknown' as const };
    expect(verifyFixedRevocationProof(proof, rotatedLookup, signedAt + 1000)).toBe(true);
    expect(verifyFixedRevocationProof({ ...proof, signedAt: new Date(gradeAt).toISOString() },
      rotatedLookup, signedAt + 1000)).toBe(false);
  });
  it('accepts only a fresh pinned authority snapshot with monotonic epoch', () => {
    const signed = signFixedRegistrySnapshot(base, signer);
    expect(verify(signed)?.authority.epoch).toBe(3);
    expect(verify(signed, 4)).toBeNull();
    expect(verifyFixedRegistrySnapshot(signed, { pinnedAuthorityMachineId: 'm_other',
      keyLookup: lookup, now: now + 1000, minimumEpoch: 0 })).toBeNull();
    expect(verifyFixedRegistrySnapshot(signed, { pinnedAuthorityMachineId: 'm_authority',
      keyLookup: lookup, now: now + 6000, minimumEpoch: 0 })).toBeNull();
  });

  it('rejects tampering, revoked and active overlap, and missing active certificates', () => {
    const signed = signFixedRegistrySnapshot(base, signer);
    expect(verify({ ...signed, epoch: 4 })).toBeNull();
    expect(verify({ ...signed, activeIds: ['c1'] })).toBeNull();
    const overlap = signFixedRegistrySnapshot({ ...base, activeIds: ['c1'], revokedIds: ['c1'] }, signer);
    expect(verify(overlap)).toBeNull();
    const malformed = { ...signed,
      certificates: [{ id: 'c1', registryEpoch: 1, fields: null } as unknown as FixedResultCertificate],
      activeIds: ['c1'] };
    expect(verify(malformed)).toBeNull();
  });

  it('keeps a durable monotonic witness across restarts and refuses same-epoch equivocation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-replica-'));
    try {
      const initial = signFixedRegistrySnapshot(base, signer);
      const replica = new JobFixedRegistryReplica(dir);
      expect(replica.accept(initial, { pinnedAuthorityMachineId: 'm_authority', keyLookup: lookup, now: now + 1000 })).toBe(true);
      replica.close();
      const reopened = new JobFixedRegistryReplica(dir);
      expect(reopened.latestEpoch()).toBe(3);
      expect(reopened.diagnosticSnapshot()?.epoch).toBe(3);
      const refreshed = signFixedRegistrySnapshot({ ...base, issuedAt: new Date(now + 500).toISOString() }, signer);
      expect(reopened.accept(refreshed, { pinnedAuthorityMachineId: 'm_authority', keyLookup: lookup, now: now + 1000 })).toBe(true);
      const altered = signFixedRegistrySnapshot({ ...base, revokedIds: ['different'] }, signer);
      expect(reopened.accept(altered, { pinnedAuthorityMachineId: 'm_authority', keyLookup: lookup, now: now + 1000 })).toBe(false);
      const stale = signFixedRegistrySnapshot({ ...base, epoch: 2 }, signer);
      expect(reopened.accept(stale, { pinnedAuthorityMachineId: 'm_authority', keyLookup: lookup, now: now + 1000 })).toBe(false);
      reopened.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-fixed-certificate-registry.test.ts' });
    }
  });

  it('issues with two independent signatures and revokes with a monotonic epoch', () => {
    const owner = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');
    const cert: FixedResultCertificate = {
      id: 'health-ok-v1', version: 1, registryEpoch: 1, slug: 'health-check',
      templateDigest: 'sha256:script-v1', featureStateHash: 'features-v1',
      result: 'success', summary: 'all-clear', reasonCode: 'all-clear', fields: { count: '0' },
      observedOutcomes: 300, gradableOutcomes: 300, confirmedMisses: 0, reviewedMissEpoch: 0,
      testEvidenceId: 'tests', shadowEvidenceId: 'shadow-300', canaryAssertionId: 'canary',
      canaryPassedAt: new Date(now - 1000).toISOString(), owner: 'owner-a', reviewer: 'reviewer-b',
      ownerSignature: '', reviewerSignature: '',
    };
    const body = fixedCertificateBody(cert);
    cert.ownerSignature = crypto.sign(null, Buffer.from(body), owner.privateKey).toString('base64');
    cert.reviewerSignature = crypto.sign(null, Buffer.from(body), reviewer.privateKey).toString('base64');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-authority-'));
    const owners = { 'owner-a': owner.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const reviewers = { 'reviewer-b': reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    const writer = new JobFixedRegistryAuthorityStore(dir, signer, 'm_authority', owners, reviewers);
    try {
      const oversized = { ...cert, id: 'oversized', fields: { blob: 'x'.repeat(500_000) },
        ownerSignature: '', reviewerSignature: '' };
      const oversizedBody = fixedCertificateBody(oversized);
      oversized.ownerSignature = crypto.sign(null, Buffer.from(oversizedBody), owner.privateKey).toString('base64');
      oversized.reviewerSignature = crypto.sign(null, Buffer.from(oversizedBody), reviewer.privateKey).toString('base64');
      expect(() => writer.issue(oversized, now)).toThrow('snapshot over cap');
      expect(writer.issue(cert, now)).toBe(1);
      const issued = verify(writer.snapshot(now + 1000), 1)!;
      expect(issued.authority.activeIds.has(cert.id)).toBe(true);
      const shape = { result: 'success' as const, summary: 'all-clear', reasonCode: 'all-clear',
        fields: { count: '0' }, missingResultLine: false, overCap: false,
        ignoredAnomalies: 0, anomalies: [], droppedFields: 0 };
      const attempt = { slug: 'health-check', templateDigest: 'sha256:script-v1', featureStateHash: 'features-v1' };
      expect(selectFixedCertificate(issued, attempt, shape).certificate?.id).toBe(cert.id);
      expect(() => writer.issue(cert, now)).toThrow();
      expect(writer.revoke(cert.id)).toBe(2);
      expect(writer.revoke(cert.id)).toBe(2);
      const revoked = verify(writer.snapshot(now + 1000), 1)!;
      expect(revoked.authority.revokedIds.has(cert.id)).toBe(true);
      expect(selectFixedCertificate(revoked, attempt, shape).certificate?.id).toBe(cert.id);
      expect(fixedSlugRecertified(revoked, cert.slug, cert.templateDigest, cert.featureStateHash)).toBe(false);
      const replacement = { ...cert, id: 'health-ok-v2', registryEpoch: 3,
        ownerSignature: '', reviewerSignature: '' };
      const replacementBody = fixedCertificateBody(replacement);
      replacement.ownerSignature = crypto.sign(null, Buffer.from(replacementBody), owner.privateKey).toString('base64');
      replacement.reviewerSignature = crypto.sign(null, Buffer.from(replacementBody), reviewer.privateKey).toString('base64');
      expect(writer.issue(replacement, now)).toBe(3);
      const recertified = verify(writer.snapshot(now + 1000), 3)!;
      expect(fixedSlugRecertified(recertified, cert.slug, cert.templateDigest, cert.featureStateHash)).toBe(true);
      expect(fixedSlugRecertified(recertified, cert.slug, cert.templateDigest, 'different-current-features')).toBe(false);
      const held = new JobSupervisionStore(dir);
      held.holdSlug(cert.slug, 'certificate-revoked', now);
      expect(held.releaseRecertifiedSlug(cert.slug, revoked, cert.templateDigest, cert.featureStateHash, now + 1000)).toBe(false);
      expect(held.releaseRecertifiedSlug(cert.slug, recertified, cert.templateDigest, cert.featureStateHash, now + 1000)).toBe(true);
      expect(held.isSlugHeld(cert.slug)).toBe(false);
      held.holdSlug(cert.slug, 'canary-stale', now + 1000);
      expect(held.releaseRecertifiedSlug(cert.slug, recertified, cert.templateDigest, cert.featureStateHash, now + 2000)).toBe(true);
      expect(held.isSlugHeld(cert.slug)).toBe(false);
      held.close();
      const renewed = { ...replacement, id: 'health-ok-v3', registryEpoch: 4,
        canaryAssertionId: 'new-canary', canaryPassedAt: new Date(now + 1000).toISOString(),
        ownerSignature: '', reviewerSignature: '' };
      const renewalBody = fixedCertificateBody(renewed);
      renewed.ownerSignature = crypto.sign(null, Buffer.from(renewalBody), owner.privateKey).toString('base64');
      renewed.reviewerSignature = crypto.sign(null, Buffer.from(renewalBody), reviewer.privateKey).toString('base64');
      expect(() => writer.renew(replacement.id, { ...renewed, canaryPassedAt: replacement.canaryPassedAt }, now + 2000))
        .toThrow('renewal review failed');
      expect(writer.snapshot(now + 2000).epoch).toBe(3);
      expect(writer.renew(replacement.id, renewed, now + 2000)).toBe(4);
      const afterRenewal = verify(writer.snapshot(now + 2000), 4, now + 2000)!;
      expect(afterRenewal.authority.revokedIds.has(replacement.id)).toBe(true);
      expect(afterRenewal.authority.activeIds.has(renewed.id)).toBe(true);
      expect(selectFixedCertificate(afterRenewal, attempt, shape).certificate?.id).toBe(renewed.id);
      // A late false-routine proof for a routinely retired cert must revoke
      // its active renewal descendant.
      expect(writer.revoke(replacement.id)).toBe(5);
      expect(writer.revoke(replacement.id)).toBe(5);
      const afterLateProof = verify(writer.snapshot(now + 2000), 5, now + 2000)!;
      expect(afterLateProof.authority.revokedIds.has(renewed.id)).toBe(true);
      expect(afterLateProof.authority.activeIds.has(renewed.id)).toBe(false);
      expect(fixedSlugRecertified(afterLateProof, cert.slug, cert.templateDigest, cert.featureStateHash)).toBe(false);
      expect(() => new JobFixedRegistryAuthorityStore(dir, signer, 'm_authority', {}, {}))
        .toThrow('principals changed');
      writer.close();
      const reopened = new JobFixedRegistryAuthorityStore(dir, signer, 'm_authority', owners, reviewers);
      expect(reopened.snapshot(now + 1000).revokedIds).toEqual([cert.id, replacement.id, renewed.id]);
      expect(reopened.snapshot(now + 1000).epoch).toBe(5);
      reopened.close();
    } finally {
      writer.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-fixed-certificate-registry.test.ts' });
    }
  });

  it('requires a fresh writer response on every read, including after a replica has a good copy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-reader-'));
    const replica = new JobFixedRegistryReplica(dir);
    let available = true;
    const reader = new JobFixedRegistryReader({ pinnedAuthorityMachineId: 'm_authority',
      keyLookup: lookup, replica, now: () => now + 1000,
      fetchSnapshot: async () => {
        if (!available) throw new Error('writer offline');
        return signFixedRegistrySnapshot(base, signer);
      } });
    try {
      expect((await reader.read())?.authority.epoch).toBe(3);
      expect(replica.latestEpoch()).toBe(3);
      available = false;
      expect(await reader.read()).toBeNull();
      expect(replica.diagnosticSnapshot()?.epoch).toBe(3);
    } finally {
      replica.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-fixed-certificate-registry.test.ts' });
    }
  });

  it('keeps a false-routine outbox pending until a signed writer snapshot proves revocation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-registry-delivery-'));
    const owner = crypto.generateKeyPairSync('ed25519');
    const reviewer = crypto.generateKeyPairSync('ed25519');
    const cert: FixedResultCertificate = {
      id: 'health-ok-v1', version: 1, registryEpoch: 1, slug: 'health-check',
      templateDigest: 'script-v1', featureStateHash: 'features-v1', result: 'success',
      summary: 'healthy', reasonCode: 'ok', fields: {}, observedOutcomes: 300,
      gradableOutcomes: 300, confirmedMisses: 0, reviewedMissEpoch: 0, testEvidenceId: 'test',
      shadowEvidenceId: 'shadow-300', canaryAssertionId: 'canary',
      canaryPassedAt: new Date(now - 1000).toISOString(), owner: 'owner-a', reviewer: 'reviewer-b',
      ownerSignature: '', reviewerSignature: '',
    };
    const body = fixedCertificateBody(cert);
    cert.ownerSignature = crypto.sign(null, Buffer.from(body), owner.privateKey).toString('base64');
    cert.reviewerSignature = crypto.sign(null, Buffer.from(body), reviewer.privateKey).toString('base64');
    const replica = new JobFixedRegistryReplica(dir);
    const ledger = new JobSupervisionStore(dir);
    const writer = new JobFixedRegistryAuthorityStore(dir, signer, 'm_authority',
      { 'owner-a': owner.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      { 'reviewer-b': reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    try {
      expect(writer.issue(cert, now)).toBe(1);
      const id = ledger.register({ runId: 'graded-fixed', fireId: 'graded-fixed-fire', slug: 'health-check',
        templateDigest: 'script-v1', featureStateHash: 'features-v1',
        decisionEligible: true, evidencePolicy: 'structured-v2', now });
      ledger.recordResult(id, { result: 'success', completedAt: new Date(now).toISOString() });
      const shape = { result: 'success' as const, summary: 'healthy', reasonCode: 'ok', fields: {},
        missingResultLine: false, overCap: false, ignoredAnomalies: 0, anomalies: [], droppedFields: 0 };
      const current = verify(writer.snapshot(now), 0)!;
      expect(ledger.resolveFixed(id, { parsed: shape, certificate: cert,
        authority: current.authority })).toBe(true);
      expect(ledger.gradeOutcome({ attemptId: id, evidenceId: 'independent-miss', ruleId: 'review',
        gradedBy: 'independent-reviewer', grade: 'incorrect', now: now + 1000 })).toBe(true);
      let tickNow = now + 2000;
      const reader = new JobFixedRegistryReader({ pinnedAuthorityMachineId: 'm_authority',
        keyLookup: lookup, replica, now: () => tickNow, fetchSnapshot: async () => writer.snapshot(tickNow) });
      let attentionCount = 0;
      const unconfirmed = new JobFixedRegistryRevocationDispatcher({ store: ledger, signer, reader,
        submit: async () => {}, now: () => tickNow, onFailure: async () => {
          attentionCount++;
          if (attentionCount === 1) throw new Error('attention transport unavailable');
        } });
      expect(await unconfirmed.tick()).toBe(0);
      expect(await unconfirmed.tick()).toBe(0);
      expect(attentionCount).toBe(1);
      expect(ledger.pendingFixedRevocations(100, tickNow)).toHaveLength(0);
      expect(ledger.pendingFixedRevocations()).toHaveLength(1); // triage still sees delayed proofs
      tickNow += 5000;
      expect(await unconfirmed.tick()).toBe(0);
      expect(attentionCount).toBe(2); // failed attention stayed retryable
      tickNow += 15_000;
      expect(ledger.pendingFixedRevocations(100, tickNow)).toHaveLength(1);
      const delivered = new JobFixedRegistryRevocationDispatcher({ store: ledger, signer, reader,
        submit: async proof => {
          expect(verifyFixedRevocationProof(proof, lookup, tickNow)).toBe(true);
          writer.revoke(proof.certificateId);
        }, now: () => tickNow });
      expect(await delivered.tick()).toBe(1);
      expect(ledger.pendingFixedRevocations()).toHaveLength(0);
      expect((await reader.read())?.authority.revokedIds.has('health-ok-v1')).toBe(true);
    } finally {
      writer.close(); ledger.close(); replica.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-fixed-certificate-registry.test.ts' });
    }
  });
});
