import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackConsumerPromotionStore } from '../../src/feedback-factory/drain/FeedbackConsumerPromotionStore.js';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackSourceGenerations } from '../../src/feedback-factory/store/FeedbackSourceGenerations.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { FeedbackInitiativeConsumer } from '../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-backup-restore.test.ts' });
});

describe('feedback drain destructive backup/restore', () => {
  it('restores a checkpointed bare host, bumps epoch, and reconciles Initiative linkage without duplication', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-restore-')); dirs.push(stateDir);
    const operatedDir = path.join(stateDir, 'state', 'feedback-factory', 'store');
    fs.mkdirSync(operatedDir, { recursive: true });
    const generations = new FeedbackSourceGenerations(operatedDir);
    generations.append({ feedbackId: 'f1', status: 'unprocessed' });
    const handoff = generations.compact(1234)!;
    generations.append({ feedbackId: 'f2', status: 'unprocessed' });

    const dbPath = path.join(operatedDir, 'feedback-drain.db');
    const store = new FeedbackDrainStore({ dbPath, tokenHmacKey: 'k'.repeat(32) });
    const authority = store.mutateAuthority({
      action: 'create', operatorDecisionRef: 'operator-create', authorityId: 'frontier', agentId: 'codey',
      ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5',
      promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 10, maxTokens: 900, maxDailySpendUsd: 5,
    });
    for (const source of generations.planFrom('canonical-feedback-v1')) {
      const projected = store.projectSourceGeneration({ filePath: source.filePath, generationId: source.generationId, limit: 500 });
      if (source.handoffToNext && projected.lagBytes === 0) store.acceptSourceHandoff({
        fromGenerationId: source.handoffToNext.fromGenerationId,
        finalOffset: source.handoffToNext.finalOffset,
        toGenerationId: source.handoffToNext.toGenerationId,
      });
    }
    store.ensureReadiness('cluster-restore');
    store.approveReady({ clusterId: 'cluster-restore', approvalKey: 'approval', authorityId: authority.authorityId,
      authorityGeneration: authority.generation, evidenceHash: 'evidence', decisionNonce: 'decision-nonce-00000001', proposalSetHash: 'a'.repeat(64) });
    const work = store.enqueue({ clusterId: 'cluster-restore', title: 'Restore me', summary: 'bounded', priority: 'normal', reportCount: 2,
      firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'frontier:1', evidenceRef: 'cluster:cluster-restore' });
    const staleClaim = store.claimNext({ consumerId: 'before-restore', ownerAuthorityEpoch: 5, leaseMs: 60_000 })!;
    const tracker = new InitiativeTracker(stateDir);
    const consumer = new FeedbackInitiativeConsumer(tracker);
    const artifact = await consumer.consume({ workId: staleClaim.workId, feedbackWorkKey: staleClaim.idempotencyKey,
      clusterId: staleClaim.clusterId, title: staleClaim.title, summary: staleClaim.summary, priority: staleClaim.priority });
    store.ensureReadiness('cluster-missing-link');
    store.approveReady({ clusterId: 'cluster-missing-link', approvalKey: 'approval-missing', authorityId: authority.authorityId,
      authorityGeneration: authority.generation, evidenceHash: 'missing-evidence', decisionNonce: 'decision-nonce-00000002', proposalSetHash: 'c'.repeat(64) });
    const missingLinkWork = store.enqueue({ clusterId: 'cluster-missing-link', title: 'Hold me', summary: 'bounded', priority: 'normal', reportCount: 1,
      firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'frontier:1', evidenceRef: 'cluster:cluster-missing-link' });
    const checkpoint = store.checkpointForBackup(5);
    expect(store.restorePending()).toBe(false);
    store.close();
    new FeedbackConsumerPromotionStore(path.join(operatedDir, 'consumer-live.json')).promote({
      approvedBatchBound: 5, evidenceHash: 'b'.repeat(64), operatorDecisionId: 'operator-promote',
    });

    const manager = new BackupManager(stateDir, undefined, () => false);
    const snapshot = manager.createSnapshot('manual');
    expect(snapshot.files.some((file) => file.endsWith('feedback-generations.json'))).toBe(true);
    SafeFsExecutor.safeRmSync(operatedDir, { recursive: true, force: true, operation: 'destructive restore positive control' });
    expect(fs.existsSync(operatedDir)).toBe(false);
    manager.restoreSnapshot(snapshot.id);

    const restoredCheckpoint = JSON.parse(fs.readFileSync(path.join(operatedDir, 'feedback-drain-checkpoint.json'), 'utf8')) as typeof checkpoint;
    expect(restoredCheckpoint).toEqual(checkpoint);
    expect(createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')).toBe(checkpoint.checksum);

    const restoredGenerations = new FeedbackSourceGenerations(operatedDir);
    expect(restoredGenerations.planFrom('canonical-feedback-v1').at(-1)?.generationId).toBe(handoff.toGenerationId);
    const restored = new FeedbackDrainStore({ dbPath, tokenHmacKey: 'k'.repeat(32) });
    try {
      expect(restored.restorePending()).toBe(true);
      expect(restored.integrityCheck()).toBe(true);
      expect(restored.verifyAuthorityAudit()).toBe(true);
      expect(restored.getAuthority('frontier')).toMatchObject({ generation: 1, revoked: false });
      expect(restored.workByKey('feedback-work:cluster-restore:1')).toMatchObject({ state: 'claimed' });
      expect(() => restored.finalizeRestore({ restoredOwnerAuthorityEpoch: 5, operatorDecisionRef: 'operator-bare-host-restore', snapshotId: checkpoint.snapshotId, manifestChecksum: '0'.repeat(64), oldOwnerQuiesced: true })).toThrow(/identity or checksum/);
      expect(() => restored.finalizeRestore({ restoredOwnerAuthorityEpoch: 5, operatorDecisionRef: 'operator-bare-host-restore', snapshotId: checkpoint.snapshotId, manifestChecksum: checkpoint.manifestChecksum })).toThrow(/quiescence/);
      expect(restored.finalizeRestore({ restoredOwnerAuthorityEpoch: 5, operatorDecisionRef: 'operator-bare-host-restore', snapshotId: checkpoint.snapshotId, manifestChecksum: checkpoint.manifestChecksum, oldOwnerQuiesced: true }))
        .toMatchObject({ ownerAuthorityEpoch: 6, invalidatedClaims: 1 });
      expect(() => restored.complete({ workId: staleClaim.workId, leaseEpoch: staleClaim.leaseEpoch,
        claimToken: staleClaim.claimToken, ownerAuthorityEpoch: 5 })).toThrow();
      expect(restored.reconcileInitiativeLinks({ lookupByFeedbackWorkKey: (key) => {
        const found = tracker.findByFeedbackWorkKey(key);
        return found ? [{ artifactId: found.id, artifactKind: found.kind, feedbackWorkKey: key, readable: true }] : [];
      } })).toMatchObject({ checked: 2, linked: 1, held: 1 });
      expect(restored.workById(missingLinkWork.workId)?.state).toBe('held');
      const resumed = restored.claimNext({ consumerId: 'after-restore', ownerAuthorityEpoch: 6, leaseMs: 60_000 })!;
      const reused = await consumer.consume({ workId: resumed.workId, feedbackWorkKey: resumed.idempotencyKey,
        clusterId: resumed.clusterId, title: resumed.title, summary: resumed.summary, priority: resumed.priority });
      expect(reused).toMatchObject({ initiativeId: artifact.initiativeId, reused: true });
      restored.markArtifactReadable({ workId: resumed.workId, leaseEpoch: resumed.leaseEpoch, claimToken: resumed.claimToken,
        ownerAuthorityEpoch: 6, artifactId: reused.initiativeId, artifactKind: 'initiative' });
      expect(restored.complete({ workId: resumed.workId, leaseEpoch: resumed.leaseEpoch, claimToken: resumed.claimToken, ownerAuthorityEpoch: 6 }).state).toBe('completed');
      expect(tracker.list().filter((row) => row.feedbackWorkKey === work.idempotencyKey)).toHaveLength(1);
      expect(restored.sourceCursor()?.generationId).toBe(handoff.toGenerationId);
    } finally { restored.close(); }
    expect(new FeedbackConsumerPromotionStore(path.join(operatedDir, 'consumer-live.json')).isLive()).toBe(true);
  });
});
