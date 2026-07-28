import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';

const dirs: string[] = [];
const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-drain-process-worker.mjs');
const approvalWorker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'feedback-approval-process-worker.mjs');
const viteNode = path.resolve('node_modules', '.bin', 'vite-node');
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-multiprocess.test.ts' });
});

function runWorker(dbPath: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(viteNode, [worker, dbPath, key], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
  });
}

function runApprovalWorker(dbPath: string, key: string, evidence: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(viteNode, [approvalWorker, dbPath, key, evidence], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`approval worker exited ${code}: ${stderr}`)));
  });
}

describe('FeedbackDrainStore multi-process fencing', () => {
  it('two real OS processes converge on one work row and one artifact link', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-drain-multiprocess-')); dirs.push(dir);
    const dbPath = path.join(dir, 'feedback-drain.db'); const key = 'k'.repeat(32);
    const seed = new FeedbackDrainStore({ dbPath, tokenHmacKey: key });
    const authority = seed.mutateAuthority({
      action: 'create', operatorDecisionRef: 'operator-1', authorityId: 'authority', agentId: 'codey',
      ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5',
      promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1',
      decisionPointId: 'feedback-cluster-readiness', maxBatch: 10, maxTokens: 900, maxDailySpendUsd: 5,
    });
    seed.ensureReadiness('cluster-process');
    seed.approveReady({ clusterId: 'cluster-process', approvalKey: 'approval', authorityId: authority.authorityId, authorityGeneration: authority.generation, evidenceHash: 'evidence', decisionNonce: 'decision-nonce-00000001', proposalSetHash: 'a'.repeat(64) });
    seed.close();

    await Promise.all([runWorker(dbPath, key), runWorker(dbPath, key)]);
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) n FROM work').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM artifact_links').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('atomically holds concurrent conflicting approvals from two real connections', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-approval-multiprocess-')); dirs.push(dir);
    const dbPath = path.join(dir, 'feedback-drain.db'); const key = 'k'.repeat(32);
    const seed = new FeedbackDrainStore({ dbPath, tokenHmacKey: key });
    seed.mutateAuthority({ action: 'create', operatorDecisionRef: 'operator-1', authorityId: 'authority', agentId: 'codey',
      ownerMachineId: 'machine-a', ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5', promptVersion: 'feedback-readiness-v1',
      schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness', maxBatch: 10, maxTokens: 900, maxDailySpendUsd: 5 });
    seed.ensureReadiness('cluster-race'); seed.close();
    await Promise.all([runApprovalWorker(dbPath, key, 'evidence-a'), runApprovalWorker(dbPath, key, 'evidence-b')]);
    const result = new FeedbackDrainStore({ dbPath, tokenHmacKey: key });
    try {
      expect(result.getReadiness('cluster-race')?.state).toBe('held');
      const db = new Database(dbPath, { readonly: true });
      expect((db.prepare('SELECT COUNT(*) n FROM readiness_approvals').get() as { n: number }).n).toBe(1);
      db.close();
    } finally { result.close(); }
  });
});
