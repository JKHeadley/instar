/**
 * The honesty layer of the Instar Documents live proof runner (scripts/documents-live-proof-lib.ts):
 * a PASS needs evidence, a failed check stays FAIL, BLOCKED needs a kind and a reason and is never
 * allowed for the load-bearing categories, and the artifact it builds is accepted by the real
 * LiveTestArtifactStore (signed, re-verified from disk).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveTestArtifactStore } from '../../src/core/LiveTestArtifactStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CheckFailed, ScenarioMatrix, check, expectEqual, hasEvidence, hostResolverRules, newRunId, plainEvidence, sendTemplate } from '../../scripts/documents-live-proof-lib.js';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/documents-live-proof-lib.test.ts' }); });

describe('ScenarioMatrix', () => {
  it('a scenario that gathers evidence and passes its checks is PASS', async () => {
    const m = new ScenarioMatrix();
    const row = await m.run({ id: 'a', description: 'd', riskCategory: 'happy-path' }, (e) => { e.status = 201; check(true, 'ok'); });
    expect(row).toMatchObject({ verdict: 'PASS', surface: 'dashboard', evidence: { status: 201 } });
  });

  it('a failed check is FAIL with what was expected and seen, and keeps the evidence gathered so far', async () => {
    const m = new ScenarioMatrix();
    const row = await m.run({ id: 'a', description: 'd', riskCategory: 'idempotency' }, (e) => { e.rows = 2; expectEqual(e.rows, 1, 'one row'); });
    expect(row.verdict).toBe('FAIL');
    expect(row.evidence).toMatchObject({ rows: 2, error: 'one row', failedCheck: { expected: 1, actual: 2 } });
  });

  it('a thrown non-check error (a timeout) is FAIL too', async () => {
    const m = new ScenarioMatrix();
    const row = await m.run({ id: 'a', description: 'd', riskCategory: 'lifecycle' }, async () => { throw new Error('Timeout 1000ms exceeded'); });
    expect(row).toMatchObject({ verdict: 'FAIL', evidence: { error: 'Timeout 1000ms exceeded' } });
  });

  it('a scenario with no evidence cannot PASS', async () => {
    const m = new ScenarioMatrix();
    const row = await m.run({ id: 'a', description: 'd', riskCategory: 'regression' }, () => undefined);
    expect(row.verdict).toBe('FAIL');
    expect(row.evidence?.error).toBe('scenario recorded no evidence');
    expect(hasEvidence({ error: 'x', screenshots: [] })).toBe(false);
    expect(hasEvidence({ status: 0 })).toBe(true);
  });

  it('BLOCKED needs a kind and a concrete reason, and is refused for happy-path and channel-parity', () => {
    const m = new ScenarioMatrix();
    expect(() => m.blocked({ id: 'h', description: 'd', riskCategory: 'happy-path' }, 'platform-error', 'The simulator is not installed on this machine at all.')).toThrow(/not allowed/);
    expect(() => m.blocked({ id: 'p', description: 'd', riskCategory: 'channel-parity' }, 'platform-error', 'The simulator is not installed on this machine at all.')).toThrow(/not allowed/);
    expect(() => m.blocked({ id: 'x', description: 'd', riskCategory: 'lifecycle' }, 'platform-error', 'short')).toThrow(/concrete reason/);
    const row = m.blocked({ id: 'y', description: 'd', riskCategory: 'lifecycle' }, 'credential-unavailable', 'No named-tunnel credential exists for throwaway agents.');
    expect(row).toMatchObject({ verdict: 'BLOCKED', blockedKind: 'credential-unavailable' });
  });

  it('ids are unique, counts and coverage follow the rows (a BLOCKED-only category is uncovered)', async () => {
    const m = new ScenarioMatrix();
    await m.run({ id: 'a', description: 'd', riskCategory: 'happy-path' }, (e) => { e.x = 1; });
    await m.run({ id: 'b', description: 'd', riskCategory: 'idempotency' }, () => { throw new CheckFailed('no'); });
    m.blocked({ id: 'c', description: 'd', riskCategory: 'lifecycle' }, 'platform-error', 'The iOS simulator runtime is not installed here.');
    await expect(m.run({ id: 'a', description: 'd', riskCategory: 'happy-path' }, (e) => { e.x = 1; })).rejects.toThrow(/used twice/);
    expect(m.counts()).toEqual({ PASS: 1, FAIL: 1, BLOCKED: 1 });
    const cov = m.coverage();
    expect(cov.covered).toEqual(['happy-path']);
    expect(cov.uncovered).toContain('lifecycle');
    expect(cov.uncovered).toContain('idempotency');
  });

  it('evidence with shared references is stored as plain data the artifact store can sign', async () => {
    const shared = ['x'];
    expect(plainEvidence({ a: shared, b: shared, f: undefined })).toEqual({ a: ['x'], b: ['x'] });
    const m = new ScenarioMatrix();
    await m.run({ id: 'a', description: 'd', riskCategory: 'happy-path' }, (e) => { e.one = shared; e.two = shared; });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-lib-')); tmp.push(dir);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const store = new LiveTestArtifactStore({
      stateDir: dir, machineId: 'm_test', signerFingerprint: 'm_test',
      sign: (d) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64'),
      verify: (d, s) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64')),
    });
    const runId = newRunId(Date.parse('2026-11-10T12:00:00Z'), 'abc123');
    expect(runId).toBe('2026-11-10T12-00-00-000Z-abc123');
    const artifact = m.artifact({ featureId: 'instar-document-viewer', runId, runnerFingerprint: 'm_test', createdAt: '2026-11-10T12:00:00.000Z' });
    expect(artifact.surfaces).toEqual(['dashboard']);
    expect(artifact.riskCategories).toEqual(['happy-path']);
    store.write(artifact);
    expect(store.verifyEntry('instar-document-viewer', runId).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('maps hostnames to local ports for Chromium', () => {
    expect(hostResolverRules({ 'a.test': 1001, 'b.test': 1002 })).toBe('MAP a.test 127.0.0.1:1001, MAP b.test 127.0.0.1:1002');
  });
  it('writes the Send template the page and the server agree on', () => {
    expect(sendTemplate(1, 'Plan', 4, 'https://h', 'id')).toBe('I left 1 comment on "Plan" (version 4): https://h/docs/id');
    expect(sendTemplate(3, 'Plan', 4, 'https://h', 'id')).toBe('I left 3 comments on "Plan" (version 4): https://h/docs/id');
  });
});
