import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DrainConflictError, FeedbackDrainStore, type FeedbackDrainCrashPoint } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const KEY = 'k'.repeat(32);
const APPROVAL_BINDING = { decisionNonce: 'decision-nonce-00000001', proposalSetHash: 'a'.repeat(64) };

describe('FeedbackDrainStore', () => {
  let now: number;
  let serial: number;
  let store: FeedbackDrainStore;

  beforeEach(() => {
    now = 10_000;
    serial = 0;
    store = new FeedbackDrainStore({
      dbPath: ':memory:',
      db: new Database(':memory:'),
      tokenHmacKey: KEY,
      clock: () => now,
      idFactory: () => `id-${++serial}`,
      tokenFactory: () => `secret-token-${++serial}`,
    });
  });

  afterEach(() => store.close());

  function authority(action: 'create' | 'replace' | 'revoke' | 'restore' = 'create') {
    return store.mutateAuthority({
      action,
      operatorDecisionRef: `operator-${action}-${serial}`,
      authorityId: 'frontier-reader',
      agentId: 'codey',
      ownerMachineId: 'machine-a',
      ownerEpoch: 7,
      provider: 'openai',
      modelFamily: 'gpt-5',
      promptVersion: 'p1',
      schemaVersion: 's1',
      decisionPointId: 'feedback-readiness',
      maxBatch: 50,
      maxTokens: 8_000,
      maxDailySpendUsd: 10,
    });
  }

  function ready(clusterId = 'cluster-1') {
    const auth = authority();
    store.ensureReadiness(clusterId, now);
    return store.approveReady({ clusterId, approvalKey: `approval-${clusterId}`, authorityId: auth.authorityId, authorityGeneration: auth.generation, evidenceHash: `evidence-${clusterId}`, ...APPROVAL_BINDING });
  }

  function enqueue(clusterId = 'cluster-1') {
    ready(clusterId);
    return store.enqueue({ clusterId, title: 'A title', summary: 'bounded summary', priority: 'high', reportCount: 4, firstSeenAt: 1, lastSeenAt: 9, authorityRef: 'decision-1', evidenceRef: 'evidence-1' });
  }

  it('keeps readiness states closed, indexes due collecting rows, and requires revalidation to release holds', () => {
    store.ensureReadiness('later', now + 10);
    store.ensureReadiness('due', now - 1);
    expect(store.dueReadiness(100).map(row => row.clusterId)).toEqual(['due']);
    const held = store.holdReadiness('due', 'source-checksum-conflict');
    expect(held.state).toBe('held');
    expect(() => store.releaseHeld('due', { revalidated: false, reason: 'wishful' })).toThrow(DrainConflictError);
    const released = store.releaseHeld('due', { revalidated: true, reason: 'checksums-valid' });
    expect(released).toMatchObject({ state: 'collecting', epoch: 1 });
  });

  it('roots authority generations in operator decisions and verifies a checksummed audit chain', () => {
    const created = authority();
    expect(created).toMatchObject({ generation: 1, revoked: false });
    expect(store.verifyAuthorityAudit()).toBe(true);
    const revoked = authority('revoke');
    expect(revoked).toMatchObject({ generation: 2, revoked: true });
    expect(store.authorityGeneration()).toBe(2);
    expect(store.verifyAuthorityAudit()).toBe(true);
    store.ensureReadiness('c');
    expect(() => store.approveReady({ clusterId: 'c', approvalKey: 'a', authorityId: 'frontier-reader', authorityGeneration: 2, evidenceHash: 'e', ...APPROVAL_BINDING })).toThrow(DrainConflictError);
    expect(() => authority('create')).toThrow(DrainConflictError);
  });

  it('rejects malformed authority envelopes and enforces the daily spend brake', () => {
    expect(() => store.mutateAuthority({
      action: 'create', operatorDecisionRef: 'op', authorityId: '', agentId: 'codey', ownerMachineId: 'm',
      ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5', promptVersion: 'p1', schemaVersion: 's1',
      decisionPointId: 'feedback-readiness', maxBatch: 1, maxTokens: 128, maxDailySpendUsd: 1,
    })).toThrow(/authorityId/);
    const auth = authority();
    expect(store.reserveAuthoritySpend(auth, 6, 1)).toBe(true);
    expect(store.reserveAuthoritySpend(auth, 5, 1)).toBe(false);
    expect(store.reserveAuthoritySpend(auth, 4, 1)).toBe(true);
  });

  it('gives only one caller ownership of an active run', () => {
    const first = store.startRun({ ownerHost: 'a', ownerEpoch: 1, leaseMs: 1000 });
    const second = store.startRun({ ownerHost: 'b', ownerEpoch: 2, leaseMs: 1000 });
    expect(first).toMatchObject({ state: 'accepted', acquired: true });
    expect(second).toMatchObject({ runId: first.runId, state: 'accepted', acquired: false });
  });

  it('persists bounded agent-request replay protection instead of relying on process memory', () => {
    expect(store.admitRequestNonce('reader', 'nonce-1234567890123456', { now, ttlMs: 10_000 })).toBe(true);
    expect(store.admitRequestNonce('reader', 'nonce-1234567890123456', { now, ttlMs: 10_000 })).toBe(false);
    now += 10_001;
    expect(store.admitRequestNonce('reader', 'nonce-1234567890123456', { now, ttlMs: 10_000 })).toBe(true);
  });

  it('keeps request replay protection across process/store restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-replay-restart-'));
    try {
      const dbPath = path.join(dir, 'drain.db');
      const first = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY, clock: () => now });
      expect(first.admitRequestNonce('reader', 'nonce-restart-00000001')).toBe(true); first.close();
      const second = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY, clock: () => now });
      expect(second.admitRequestNonce('reader', 'nonce-restart-00000001')).toBe(false); second.close();
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-store.test.ts' }); }
  });

  it('restores the immutable authority generations and audit chain from the checksummed sidecar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-authority-restore-'));
    try {
      const dbPath = path.join(dir, 'feedback-drain.db');
      const original = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY });
      original.mutateAuthority({
        action: 'create', operatorDecisionRef: 'operator-create', authorityId: 'frontier', agentId: 'codey',
        ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5',
        promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
        decisionPointId: 'feedback-cluster-readiness', maxBatch: 10, maxTokens: 900, maxDailySpendUsd: 5,
      });
      original.close();
      for (const suffix of ['', '-wal', '-shm']) {
        const target = `${dbPath}${suffix}`;
        if (fs.existsSync(target)) SafeFsExecutor.safeUnlinkSync(target, { operation: 'feedback-drain-store.test.ts' });
      }
      const restored = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY });
      expect(restored.getAuthority('frontier')).toMatchObject({ agentId: 'codey', generation: 1, revoked: false });
      expect(restored.verifyAuthorityAudit()).toBe(true);
      restored.close();
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-store.test.ts' }); }
  });

  it('destructively restores with a bumped owner epoch and reconciles Initiative links by exact feedbackWorkKey', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-destructive-restore-'));
    const dbPath = path.join(dir, 'feedback-drain.db');
    const snapshotPath = path.join(dir, 'checkpointed-feedback-drain.db');
    let restored: FeedbackDrainStore | null = null;
    try {
      const original = new FeedbackDrainStore({
        dbPath, tokenHmacKey: KEY, clock: () => now,
        idFactory: () => `restore-work-${++serial}`,
        tokenFactory: () => `restore-claim-token-${++serial}`,
      });
      const auth = original.mutateAuthority({
        action: 'create', operatorDecisionRef: 'operator-restore-fixture', authorityId: 'restore-reader', agentId: 'codey',
        ownerMachineId: 'machine-a', ownerEpoch: 5, provider: 'openai', modelFamily: 'gpt-5', promptVersion: 'p1',
        schemaVersion: 's1', decisionPointId: 'feedback-readiness', maxBatch: 10, maxTokens: 1_000, maxDailySpendUsd: 2,
      });
      const addWork = (clusterId: string) => {
        original.ensureReadiness(clusterId);
        original.approveReady({ clusterId, approvalKey: `approval-${clusterId}`, authorityId: auth.authorityId,
          authorityGeneration: auth.generation, evidenceHash: `evidence-${clusterId}`,
          decisionNonce: `decision-${clusterId}-00000001`, proposalSetHash: 'b'.repeat(64) });
        return original.enqueue({ clusterId, title: clusterId, summary: 'scrubbed', priority: 'normal', reportCount: 1,
          firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'authority', evidenceRef: 'evidence' });
      };
      const linkedWork = addWork('restore-linked');
      const missingWork = addWork('restore-missing');
      const staleClaim = original.claimNext({ consumerId: 'before-restore', ownerAuthorityEpoch: 5, leaseMs: 60_000 })!;
      const activeRun = original.startRun({ ownerHost: 'machine-a', ownerEpoch: 5, leaseMs: 60_000 });
      original.transitionRun(activeRun.runId, 'accepted', 'running', '', { ownerHost: 'machine-a', ownerEpoch: 5 });
      const checkpoint = original.checkpointForBackup(5);
      original.close();
      fs.copyFileSync(dbPath, snapshotPath);

      // Positive-control destructive fixture: remove the entire SQLite family,
      // then recover only from the checkpointed artifact.
      for (const suffix of ['', '-wal', '-shm']) {
        const target = `${dbPath}${suffix}`;
        if (fs.existsSync(target)) SafeFsExecutor.safeUnlinkSync(target, { operation: 'feedback-drain-destructive-restore-test' });
      }
      fs.copyFileSync(snapshotPath, dbPath);
      restored = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY, clock: () => now, tokenFactory: () => 'post-restore-token' });
      expect(restored.finalizeRestore({ restoredOwnerAuthorityEpoch: 5, operatorDecisionRef: 'operator-restore-1', snapshotId: checkpoint.snapshotId, manifestChecksum: checkpoint.manifestChecksum, oldOwnerQuiesced: true }))
        .toEqual({ ownerAuthorityEpoch: 6, invalidatedClaims: 1, abandonedRuns: 1 });
      expect(restored.ownerAuthorityEpoch()).toBe(6);
      expect(restored.workById(staleClaim.workId)).toMatchObject({ state: 'retryable', leaseEpoch: staleClaim.leaseEpoch + 1 });
      expect(restored.lastRun()).toMatchObject({ runId: activeRun.runId, state: 'abandoned', reason: 'restore-epoch-bump' });
      expect(() => restored!.claimNext({ consumerId: 'stale-owner', ownerAuthorityEpoch: 5, leaseMs: 1_000 })).toThrow(DrainConflictError);

      const reconciliation = restored.reconcileInitiativeLinks({
        lookupByFeedbackWorkKey: (key) => key === linkedWork.idempotencyKey
          ? [{ artifactId: 'initiative-linked', artifactKind: 'initiative', feedbackWorkKey: key, readable: true }]
          : [],
      });
      expect(reconciliation).toEqual({ checked: 2, linked: 1, held: 1, degraded: 0 });
      expect(restored.workById(missingWork.workId)?.state).toBe('held');

      const currentClaim = restored.claimNext({ consumerId: 'after-restore', ownerAuthorityEpoch: 6, leaseMs: 1_000 })!;
      expect(currentClaim.workId).toBe(linkedWork.workId);
      expect(() => restored!.complete({ workId: staleClaim.workId, leaseEpoch: staleClaim.leaseEpoch,
        claimToken: staleClaim.claimToken, ownerAuthorityEpoch: 5 })).toThrow(DrainConflictError);
      expect(restored.complete({ workId: currentClaim.workId, leaseEpoch: currentClaim.leaseEpoch,
        claimToken: currentClaim.claimToken, ownerAuthorityEpoch: 6 }).state).toBe('completed');
    } finally {
      restored?.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-store.test.ts' });
    }
  });

  it('replays crash boundaries around source projection and detects later checksum corruption', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-source-projection-'));
    try {
      const source = path.join(dir, 'feedback.jsonl');
      fs.writeFileSync(source, [
        JSON.stringify({ feedbackId: 'f1', sourceRecordId: 's1' }),
        JSON.stringify({ feedbackId: 'f2', sourceRecordId: 's2' }),
      ].join('\n') + '\n');
      expect(() => store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1, crashPoint: 'after-read' })).toThrow(/injected/);
      expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1 })).toMatchObject({ projected: 1 });
      expect(() => store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1, crashPoint: 'after-insert' })).toThrow(/injected/);
      expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1 })).toMatchObject({ projected: 1 });
      fs.appendFileSync(source, `${JSON.stringify({ feedbackId: 'f3', sourceRecordId: 's3' })}\n`);
      expect(() => store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1, crashPoint: 'after-commit' })).toThrow(/injected/);
      expect(store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1 })).toMatchObject({ projected: 0, lagBytes: 0 });
      fs.appendFileSync(source, `${JSON.stringify({ feedbackId: 'changed', sourceRecordId: 's1' })}\n`);
      expect(() => store.projectSourceGeneration({ filePath: source, generationId: 'g1', limit: 1 })).toThrow(/checksum conflicts/);
      expect(store.metrics().sourceChecksumConflicts).toBe(1);
      const bytes = fs.readFileSync(source, 'utf8').replace('"f1"', '"x1"');
      fs.writeFileSync(source, bytes);
      expect(store.reconcileSourceProjection({ filePath: source, generationId: 'g1', limit: 500 })).toMatchObject({ conflicts: 1 });
      expect(store.metrics().sourceChecksumConflicts).toBe(1);
      SafeFsExecutor.safeRmSync(source, { force: true, operation: 'feedback source missing-generation fixture' });
      expect(() => store.reconcileSourceProjection({ filePath: source, generationId: 'g1', limit: 500 })).toThrow(/generation is missing/);
      expect(store.metrics().sourceChecksumConflicts).toBe(2);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-store.test.ts' }); }
  });

  it('makes readiness approval and enqueue idempotent at their exact keys', () => {
    const auth = authority();
    store.ensureReadiness('c');
    const input = { clusterId: 'c', approvalKey: 'approval', authorityId: auth.authorityId, authorityGeneration: auth.generation, evidenceHash: 'evidence', ...APPROVAL_BINDING };
    expect(store.approveReady(input).epoch).toBe(1);
    expect(store.approveReady(input)).toMatchObject({ state: 'ready', epoch: 1 });
    const workInput = { clusterId: 'c', title: 'one', summary: 'safe', priority: 'p1', reportCount: 2, firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'auth', evidenceRef: 'evidence' };
    const first = store.enqueue(workInput);
    const second = store.enqueue(workInput);
    expect(second.workId).toBe(first.workId);
    expect(second.idempotencyKey).toBe('feedback-work:c:1');
    expect(store.metrics().work.queued).toBe(1);
    expect(store.getReadiness('c')?.state).toBe('queued');
  });

  it('holds on a reused approval key whose evidence drifts', () => {
    const auth = authority();
    store.ensureReadiness('c');
    store.approveReady({ clusterId: 'c', approvalKey: 'same', authorityId: auth.authorityId, authorityGeneration: auth.generation, evidenceHash: 'e1', ...APPROVAL_BINDING });
    expect(() => store.approveReady({ clusterId: 'c', approvalKey: 'same', authorityId: auth.authorityId, authorityGeneration: auth.generation, evidenceHash: 'e2', ...APPROVAL_BINDING })).toThrow(DrainConflictError);
    expect(store.getReadiness('c')?.state).toBe('held');
  });

  it('holds the exact batch when a reused approval key drifts to another proposal set', () => {
    const auth = authority(); store.ensureReadiness('proposal-drift');
    const base = { clusterId: 'proposal-drift', approvalKey: 'proposal-key', authorityId: auth.authorityId,
      authorityGeneration: auth.generation, evidenceHash: 'evidence', decisionNonce: 'decision-nonce-00000001' };
    store.approveReady({ ...base, proposalSetHash: 'a'.repeat(64) });
    expect(() => store.approveReady({ ...base, proposalSetHash: 'b'.repeat(64) })).toThrow(DrainConflictError);
    expect(store.getReadiness('proposal-drift')?.state).toBe('held');
  });

  it('keeps authority lookup active per id when another authority advances the registry generation', () => {
    const first = authority();
    store.mutateAuthority({
      action: 'create', operatorDecisionRef: 'operator-second', authorityId: 'second-reader', agentId: 'codey-2',
      ownerMachineId: 'machine-b', ownerEpoch: 8, provider: 'openai', modelFamily: 'gpt-5',
      promptVersion: 'p1', schemaVersion: 's1', decisionPointId: 'feedback-readiness', maxBatch: 10,
      maxTokens: 1_000, maxDailySpendUsd: 2,
    });
    expect(store.getAuthority(first.authorityId)).toMatchObject({ generation: first.generation, revoked: false });
    expect(store.reserveAuthoritySpend(first, 0.1, 1)).toBe(true);
  });

  it('persists only a token HMAC and rejects stale-epoch acknowledgements', () => {
    const work = enqueue();
    const first = store.claimNext({ consumerId: 'consumer-a', ownerAuthorityEpoch: 12, leaseMs: 100 })!;
    expect(first.workId).toBe(work.workId);
    expect(first.claimToken).toContain('secret-token');
    expect(JSON.stringify(store.workById(work.workId))).not.toContain(first.claimToken);
    now = 10_101;
    expect(store.reconcileExpiredLeases({ retryDelayMs: 0, maxAttempts: 3 })).toEqual({ reconciled: 1, retryable: 1, deadLettered: 0 });
    const second = store.claimNext({ consumerId: 'consumer-b', ownerAuthorityEpoch: 12, leaseMs: 100 })!;
    expect(second.leaseEpoch).toBe(first.leaseEpoch + 2); // expiry invalidation + new claim
    expect(() => store.markArtifactReadable({ workId: work.workId, leaseEpoch: first.leaseEpoch, claimToken: first.claimToken, ownerAuthorityEpoch: 12, artifactId: 'old', artifactKind: 'initiative' })).toThrow(DrainConflictError);
    store.markArtifactReadable({ workId: work.workId, leaseEpoch: second.leaseEpoch, claimToken: second.claimToken, ownerAuthorityEpoch: 12, artifactId: 'initiative-1', artifactKind: 'initiative' });
    expect(() => store.complete({ workId: work.workId, leaseEpoch: second.leaseEpoch, claimToken: second.claimToken, ownerAuthorityEpoch: 11 })).toThrow(DrainConflictError);
    expect(store.complete({ workId: work.workId, leaseEpoch: second.leaseEpoch, claimToken: second.claimToken, ownerAuthorityEpoch: 12 }).state).toBe('completed');
  });

  it('requires readable linkage before completion and uses exact retry/dead-letter transitions', () => {
    enqueue();
    const claim = store.claimNext({ consumerId: 'consumer', ownerAuthorityEpoch: 1, leaseMs: 50 })!;
    expect(() => store.complete({ workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: 1 })).toThrow(DrainConflictError);
    const retryable = store.retry({ workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: 1, retryAt: now + 100, maxAttempts: 2, reason: 'downstream-timeout' });
    expect(retryable.state).toBe('retryable');
    expect(store.claimNext({ consumerId: 'consumer', ownerAuthorityEpoch: 1, leaseMs: 50 })).toBeNull();
    now += 100;
    const finalClaim = store.claimNext({ consumerId: 'consumer', ownerAuthorityEpoch: 1, leaseMs: 50 })!;
    expect(store.retry({ workId: finalClaim.workId, leaseEpoch: finalClaim.leaseEpoch, claimToken: finalClaim.claimToken, ownerAuthorityEpoch: 1, retryAt: now, maxAttempts: 2, reason: 'exhausted' }).state).toBe('dead-lettered');
  });

  it('bounds expired-lease reconciliation and exposes state/age/progress metrics', () => {
    const work = enqueue();
    const claim = store.claimNext({ consumerId: 'consumer', ownerAuthorityEpoch: 2, leaseMs: 50 })!;
    now += 60;
    expect(store.reconcileExpiredLeases({ limit: 0, retryDelayMs: 10, maxAttempts: 3 }).reconciled).toBe(0);
    expect(store.reconcileExpiredLeases({ limit: 1, retryDelayMs: 10, maxAttempts: 3 }).reconciled).toBe(1);
    const metrics = store.metrics();
    expect(metrics.work.retryable).toBe(1);
    expect(metrics.oldestQueuedAgeMs).toBe(60);
    expect(metrics.lastClaimedAt).toBe(10_000);
    expect(JSON.stringify(metrics)).not.toContain(claim.claimToken);
    expect(store.workById(work.workId)?.leaseEpoch).toBe(2);
  });

  it('deduplicates concurrent run admission and permits only closed run transitions', () => {
    const first = store.startRun({ ownerHost: 'host', ownerEpoch: 1, leaseMs: 100 });
    const duplicate = store.startRun({ ownerHost: 'other', ownerEpoch: 2, leaseMs: 100 });
    expect(duplicate.runId).toBe(first.runId);
    store.transitionRun(first.runId, 'accepted', 'running');
    expect(() => store.heartbeatRun(first.runId, 'host', 2, 100)).toThrow(DrainConflictError);
    store.heartbeatRun(first.runId, 'host', 1, 100);
    expect(() => store.transitionRun(first.runId, 'running', 'succeeded', '', { ownerHost: 'host', ownerEpoch: 2 })).toThrow(DrainConflictError);
    expect(() => store.transitionRun(first.runId, 'running', 'accepted')).toThrow(DrainConflictError);
    now += 101;
    expect(store.abandonExpiredRuns()).toBe(1);
    expect(store.startRun({ ownerHost: 'host', ownerEpoch: 2, leaseMs: 100 }).runId).not.toBe(first.runId);
  });

  it('rejects invalid transitions and reports SQLite integrity', () => {
    expect(store.integrityCheck()).toBe(true);
    store.ensureReadiness('c');
    expect(() => store.enqueue({ clusterId: 'c', title: 'x', summary: 'x', priority: 'x', reportCount: 1, firstSeenAt: 1, lastSeenAt: 1, authorityRef: 'x', evidenceRef: 'x' })).toThrow(DrainConflictError);
  });

  it('checkpoints WAL state with an epoch-bound database checksum before backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-checkpoint-'));
    const dbPath = path.join(dir, 'feedback-drain.db');
    const disk = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY, clock: () => now });
    try {
      const checkpoint = disk.checkpointForBackup(7);
      expect(checkpoint).toMatchObject({ ownerAuthorityEpoch: 7, createdAt: new Date(now).toISOString() });
      expect(checkpoint.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'feedback-drain-checkpoint.json'), 'utf8'))).toEqual(checkpoint);
      expect(() => disk.checkpointForBackup(8)).toThrow(DrainConflictError);
    } finally {
      disk.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-store checkpoint test' });
    }
  });

  it('escapes control and newline injection at the authoritative queue boundary', () => {
    ready('control-cluster');
    const work = store.enqueue({ clusterId: 'control-cluster', title: 'line1\nline2\u0000', summary: 'safe\r\nsummary\u001b',
      priority: 'high\nforged', reportCount: 1, firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'a\n', evidenceRef: 'e\r' });
    expect(JSON.stringify(work)).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
    expect(work.title).toBe('line1 line2');
  });

  it('requests cancellation durably and stops only at an explicit stage boundary under the run fence', () => {
    const run = store.startRun({ ownerHost: 'host', ownerEpoch: 3, leaseMs: 100 });
    store.transitionRun(run.runId, 'accepted', 'running', '', { ownerHost: 'host', ownerEpoch: 3 });
    expect(store.isRunCancellationRequested(run.runId, { ownerHost: 'host', ownerEpoch: 3 })).toBe(false);
    expect(() => store.requestRunCancellation(run.runId, { ownerHost: 'other', ownerEpoch: 3 })).toThrow(DrainConflictError);
    expect(store.requestRunCancellation(run.runId, { ownerHost: 'host', ownerEpoch: 3 })).toBe(true);
    expect(store.lastRun()?.state).toBe('running');
    expect(store.stopCancelledRunAtBoundary(run.runId, { ownerHost: 'host', ownerEpoch: 3 })).toBe(true);
    expect(store.lastRun()).toMatchObject({ state: 'abandoned', reason: 'cancelled-at-stage-boundary' });
  });

  it('prunes queue/audit at 400 days and run detail at 30 days, bounded and owner-fenced, while retaining idempotency tombstones', () => {
    const work = enqueue();
    const claim = store.claimNext({ consumerId: 'consumer', ownerAuthorityEpoch: 4, leaseMs: 100 });
    store.markArtifactReadable({ workId: claim!.workId, leaseEpoch: claim!.leaseEpoch, claimToken: claim!.claimToken, ownerAuthorityEpoch: 4, artifactId: 'initiative', artifactKind: 'initiative' });
    store.complete({ workId: claim!.workId, leaseEpoch: claim!.leaseEpoch, claimToken: claim!.claimToken, ownerAuthorityEpoch: 4 });
    const run = store.startRun({ ownerHost: 'host', ownerEpoch: 4, leaseMs: 100 });
    store.transitionRun(run.runId, 'accepted', 'running', '', { ownerHost: 'host', ownerEpoch: 4 });
    store.transitionRun(run.runId, 'running', 'succeeded', '', { ownerHost: 'host', ownerEpoch: 4 });
    now += 401 * 24 * 60 * 60 * 1000;
    expect(() => store.pruneOperationalHistory({ ownerHost: 'host', ownerAuthorityEpoch: 5, now })).toThrow(DrainConflictError);
    const result = store.pruneOperationalHistory({ ownerHost: 'host', ownerAuthorityEpoch: 4, now, limit: 100 });
    expect(result.retiredWork).toBe(1);
    expect(result.prunedAudit).toBeGreaterThan(0);
    expect(result.prunedRuns).toBe(1);
    expect(result.checkpointed).toBe(true);
    expect(store.workById(work.workId)).toBeNull();
    expect(store.isRetiredWorkKey(work.idempotencyKey)).toBe(true);
  });
});

describe('FeedbackDrainStore crash/replay boundary matrix', () => {
  const key = 'z'.repeat(32);
  let now = 20_000;
  let armed: FeedbackDrainCrashPoint | null;
  let store: FeedbackDrainStore;
  let sequence: number;

  function reset(): void {
    store?.close();
    armed = null; sequence = 0; now = 20_000;
    store = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: key, clock: () => now,
      idFactory: () => `crash-work-${++sequence}`, tokenFactory: () => `crash-token-${++sequence}`,
      crashInjector: (point) => { if (point === armed) throw new Error(`injected:${point}`); } });
  }

  function seedAuthority() {
    return store.mutateAuthority({ action: 'create', operatorDecisionRef: 'operator', authorityId: 'reader', agentId: 'codey',
      ownerMachineId: 'host', ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5', promptVersion: 'p1', schemaVersion: 's1',
      decisionPointId: 'feedback-readiness', maxBatch: 10, maxTokens: 1000, maxDailySpendUsd: 2 });
  }

  function approval(clusterId: string) {
    const auth = seedAuthority(); store.ensureReadiness(clusterId);
    return { clusterId, approvalKey: `approval-${clusterId}`, authorityId: auth.authorityId, authorityGeneration: auth.generation,
      evidenceHash: 'evidence', decisionNonce: 'decision-nonce-00000001', proposalSetHash: 'c'.repeat(64) };
  }

  function seedWork(clusterId = 'cluster') {
    const approved = approval(clusterId); store.approveReady(approved);
    const input = { clusterId, title: 'title', summary: 'summary', priority: 'normal', reportCount: 1,
      firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'authority', evidenceRef: 'evidence' };
    return { work: store.enqueue(input), enqueueInput: input };
  }

  afterEach(() => store?.close());

  it.each(['readiness-after-state', 'readiness-after-approval'] as FeedbackDrainCrashPoint[])('rolls back %s and replays one approval', (point) => {
    reset(); const input = approval(point); armed = point;
    expect(() => store.approveReady(input)).toThrow(`injected:${point}`);
    expect(store.getReadiness(point)?.state).toBe('collecting');
    armed = null; expect(store.approveReady(input)).toMatchObject({ state: 'ready', epoch: 1 });
  });

  it('replays a readiness response lost after commit without advancing twice', () => {
    reset(); const input = approval('readiness-post'); armed = 'readiness-after-commit';
    expect(() => store.approveReady(input)).toThrow('injected:readiness-after-commit');
    armed = null; expect(store.approveReady(input)).toMatchObject({ state: 'ready', epoch: 1 });
  });

  it.each(['enqueue-after-work', 'enqueue-after-readiness', 'enqueue-after-link'] as FeedbackDrainCrashPoint[])('rolls back %s and replays one outbox row', (point) => {
    reset(); const approve = approval(point); store.approveReady(approve);
    const input = { clusterId: point, title: 't', summary: 's', priority: 'p', reportCount: 1, firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'a', evidenceRef: 'e' };
    armed = point; expect(() => store.enqueue(input)).toThrow(`injected:${point}`);
    expect(store.getReadiness(point)?.state).toBe('ready');
    armed = null; expect(store.enqueue(input).idempotencyKey).toBe(`feedback-work:${point}:1`);
    expect(store.metrics().work.queued).toBe(1);
  });

  it('replays enqueue after a committed response loss without duplication', () => {
    reset(); const approve = approval('enqueue-post'); store.approveReady(approve);
    const input = { clusterId: 'enqueue-post', title: 't', summary: 's', priority: 'p', reportCount: 1, firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'a', evidenceRef: 'e' };
    armed = 'enqueue-after-commit'; expect(() => store.enqueue(input)).toThrow('injected:enqueue-after-commit');
    armed = null; const replay = store.enqueue(input);
    expect(replay.idempotencyKey).toBe('feedback-work:enqueue-post:1'); expect(store.metrics().work.queued).toBe(1);
  });

  it('rolls claim updates back before commit and fences a token lost after commit', () => {
    reset(); const { work } = seedWork(); armed = 'claim-after-update';
    expect(() => store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 })).toThrow('injected:claim-after-update');
    expect(store.workById(work.workId)?.state).toBe('queued');
    armed = 'claim-after-commit'; expect(() => store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 })).toThrow('injected:claim-after-commit');
    expect(store.workById(work.workId)?.state).toBe('claimed');
    armed = null; now += 11; store.reconcileExpiredLeases({ now, retryDelayMs: 0, maxAttempts: 3 });
    expect(store.claimNext({ consumerId: 'c2', ownerAuthorityEpoch: 1, leaseMs: 10 })?.workId).toBe(work.workId);
  });

  it.each(['artifact-link-after-update', 'artifact-link-after-commit'] as FeedbackDrainCrashPoint[])('recovers exact artifact linkage across %s', (point) => {
    reset(); const { work } = seedWork(); const claim = store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 })!;
    const input = { workId: work.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: 1, artifactId: 'initiative', artifactKind: 'initiative' };
    armed = point; expect(() => store.markArtifactReadable(input)).toThrow(`injected:${point}`);
    armed = null; store.markArtifactReadable(input); expect(store.complete(input).state).toBe('completed');
  });

  it.each(['completion-after-update', 'completion-after-commit'] as FeedbackDrainCrashPoint[])('preserves exactly-once completion across %s', (point) => {
    reset(); const { work } = seedWork(); const claim = store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 })!;
    const input = { workId: work.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: 1 };
    store.markArtifactReadable({ ...input, artifactId: 'initiative', artifactKind: 'initiative' });
    armed = point; expect(() => store.complete(input)).toThrow(`injected:${point}`);
    armed = null;
    if (point === 'completion-after-update') expect(store.complete(input).state).toBe('completed');
    else expect(store.workById(work.workId)?.state).toBe('completed');
  });

  it.each(['retry-after-update', 'retry-after-commit'] as FeedbackDrainCrashPoint[])('preserves retry/dead-letter exactness across %s', (point) => {
    reset(); const { work } = seedWork(); const claim = store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 })!;
    const input = { workId: work.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: 1, retryAt: now, maxAttempts: 1, reason: 'exhausted' };
    armed = point; expect(() => store.retry(input)).toThrow(`injected:${point}`); armed = null;
    if (point === 'retry-after-update') expect(store.retry(input).state).toBe('dead-lettered');
    else expect(store.workById(work.workId)?.state).toBe('dead-lettered');
  });

  it.each(['run-after-transition', 'run-after-commit'] as FeedbackDrainCrashPoint[])('replays run transition safely across %s', (point) => {
    reset(); const run = store.startRun({ ownerHost: 'host', ownerEpoch: 1, leaseMs: 10 }); armed = point;
    expect(() => store.transitionRun(run.runId, 'accepted', 'running', '', { ownerHost: 'host', ownerEpoch: 1 })).toThrow(`injected:${point}`); armed = null;
    if (point === 'run-after-transition') store.transitionRun(run.runId, 'accepted', 'running', '', { ownerHost: 'host', ownerEpoch: 1 });
    expect(store.lastRun()?.state).toBe('running');
  });

  it.each(['restore-after-claims', 'restore-after-runs', 'restore-after-epoch'] as FeedbackDrainCrashPoint[])('atomically rolls back restore at %s', (point) => {
    reset(); seedWork(); store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 });
    const run = store.startRun({ ownerHost: 'host', ownerEpoch: 1, leaseMs: 10 }); store.transitionRun(run.runId, 'accepted', 'running');
    armed = point; expect(() => store.finalizeRestore({ restoredOwnerAuthorityEpoch: 1, operatorDecisionRef: 'operator', oldOwnerQuiesced: true })).toThrow(`injected:${point}`);
    expect(store.ownerAuthorityEpoch()).toBe(1); expect(store.metrics().work.claimed).toBe(1); expect(store.lastRun()?.state).toBe('running');
    armed = null; expect(store.finalizeRestore({ restoredOwnerAuthorityEpoch: 1, operatorDecisionRef: 'operator', oldOwnerQuiesced: true }).ownerAuthorityEpoch).toBe(2);
  });

  it('keeps the restore epoch bump durable when the response is lost after commit', () => {
    reset(); seedWork(); store.claimNext({ consumerId: 'c', ownerAuthorityEpoch: 1, leaseMs: 10 });
    armed = 'restore-after-commit'; expect(() => store.finalizeRestore({ restoredOwnerAuthorityEpoch: 1, operatorDecisionRef: 'operator', oldOwnerQuiesced: true })).toThrow('injected:restore-after-commit');
    armed = null; expect(store.ownerAuthorityEpoch()).toBe(2);
    expect(() => store.finalizeRestore({ restoredOwnerAuthorityEpoch: 1, operatorDecisionRef: 'operator', oldOwnerQuiesced: true })).toThrow(DrainConflictError);
  });
});
