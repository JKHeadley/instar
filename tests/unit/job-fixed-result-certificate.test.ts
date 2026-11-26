import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { decideFixedResult, fixedCertificateBody, type FixedResultCertificate, type FixedCertificateAuthority } from '../../src/scheduler/JobFixedResultCertificate.js';
import { JobSupervisionStore } from '../../src/scheduler/JobSupervisionStore.js';
import type { ParsedScriptRun } from '../../src/scheduler/jobScriptProtocol.js';
import type { SupervisionAttempt } from '../../src/scheduler/JobSupervisionStore.js';

const now = Date.parse('2026-10-28T00:00:00Z');
const parsed: ParsedScriptRun = { result: 'success', reason: 'all-clear', reasonCode: 'all-clear', summary: 'all-clear',
  anomalies: [], ignoredAnomalies: 0, fields: { count: '0' }, droppedFields: 0,
  missingResultLine: false, overCap: false };
const attempt = { slug: 'health-check', templateDigest: 'sha256:script-v1', featureStateHash: 'features-v1' } as SupervisionAttempt;

function fixture() {
  const owner = crypto.generateKeyPairSync('ed25519');
  const reviewer = crypto.generateKeyPairSync('ed25519');
  const cert: FixedResultCertificate = {
    id: 'health-ok-v1', version: 1, registryEpoch: 7, slug: 'health-check',
    templateDigest: 'sha256:script-v1', featureStateHash: 'features-v1',
    result: 'success', summary: 'all-clear', reasonCode: 'all-clear', fields: { count: '0' },
    observedOutcomes: 300, gradableOutcomes: 300, confirmedMisses: 0,
    testEvidenceId: 'unit-boundary-v1', shadowEvidenceId: 'shadow-300-v1',
    canaryAssertionId: 'canary-1', canaryPassedAt: new Date(now - 60_000).toISOString(),
    owner: 'owner-a', reviewer: 'reviewer-b', ownerSignature: '', reviewerSignature: '',
  };
  const sign = () => {
    const body = fixedCertificateBody(cert);
    cert.ownerSignature = crypto.sign(null, Buffer.from(body), owner.privateKey).toString('base64');
    cert.reviewerSignature = crypto.sign(null, Buffer.from(body), reviewer.privateKey).toString('base64');
  };
  sign();
  const authority: FixedCertificateAuthority = {
    epoch: 7, activeIds: new Set([cert.id]), revokedIds: new Set(), now,
    ownerPublicKeys: { 'owner-a': owner.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    reviewerPublicKeys: { 'reviewer-b': reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
  return { cert, authority, sign };
}

describe('exact fixed-result certificates', () => {
  it('accepts an exact reviewed shape with two valid signatures and fresh canary', () => {
    const { cert, authority } = fixture();
    expect(decideFixedResult({ attempt, parsed, certificate: cert, authority }))
      .toEqual({ kind: 'fixed', certificateId: cert.id });
    expect(decideFixedResult({ attempt, parsed, certificate: cert,
      authority: { ...authority, epoch: 8 } })).toMatchObject({ kind: 'fixed' });
  });

  it('routes ordinary new fields or summary changes to judgment', () => {
    const { cert, authority } = fixture();
    expect(decideFixedResult({ attempt, parsed: { ...parsed, droppedFields: 1 }, certificate: cert, authority }).kind).toBe('judgment');
    expect(decideFixedResult({ attempt, parsed: { ...parsed, summary: 'new message' }, certificate: cert, authority }).kind).toBe('judgment');
    expect(decideFixedResult({ attempt, parsed, certificate: null, authority }).kind).toBe('judgment');
  });

  it('holds on revocation, stale registry, invalid signature, missing proof or run snapshot mismatch', () => {
    const { cert, authority, sign } = fixture();
    expect(decideFixedResult({ attempt, parsed, certificate: cert,
      authority: { ...authority, revokedIds: new Set([cert.id]) } })).toEqual({ kind: 'hold', reason: 'certificate-revoked' });
    expect(decideFixedResult({ attempt, parsed, certificate: cert,
      authority: { ...authority, epoch: null } })).toEqual({ kind: 'hold', reason: 'registry-unreadable' });
    cert.summary = 'tampered';
    expect(decideFixedResult({ attempt, parsed, certificate: cert, authority })).toEqual({ kind: 'hold', reason: 'certificate-signature-invalid' });
    cert.summary = 'all-clear'; sign();
    cert.gradableOutcomes = 299; sign();
    expect(decideFixedResult({ attempt, parsed, certificate: cert, authority })).toEqual({ kind: 'hold', reason: 'certificate-evidence-incomplete' });
    cert.gradableOutcomes = 300; sign();
    expect(decideFixedResult({ attempt: { ...attempt, featureStateHash: 'changed' }, parsed, certificate: cert, authority }))
      .toEqual({ kind: 'hold', reason: 'run-snapshot-mismatch' });
  });

  it('the durable ledger closes only a verified certificate and holds a revoked one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-result-ledger-'));
    const store = new JobSupervisionStore(dir);
    try {
      const { cert, authority } = fixture();
      expect(store.isSlugHeld('health-check')).toBe(false);
      const add = (runId: string) => {
        const id = store.register({ runId, fireId: `fire:${runId}`, slug: 'health-check',
          templateDigest: attempt.templateDigest, featureStateHash: attempt.featureStateHash,
          decisionEligible: true, evidencePolicy: 'structured-v2', now });
        store.recordResult(id, { result: 'success', completedAt: new Date(now).toISOString() });
        return id;
      };
      const good = add('good');
      expect(store.resolveFixed(good, { parsed, certificate: cert, authority })).toBe(true);
      expect(store.get(good)).toMatchObject({ status: 'resolved', provider: 'fixed', verdict: 'routine' });
      const revoked = add('revoked');
      expect(store.resolveFixed(revoked, { parsed, certificate: cert,
        authority: { ...authority, revokedIds: new Set([cert.id]) } })).toBe(false);
      expect(store.get(revoked)).toMatchObject({ status: 'unchecked', reason: 'certificate-revoked' });
      expect(store.heldSlugs()).toEqual([expect.objectContaining({ slug: 'health-check', reason: 'certificate-revoked' })]);
      expect(store.isSlugHeld('health-check')).toBe(true);
    } finally {
      store.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-fixed-result-certificate.test.ts' });
    }
  });
});
