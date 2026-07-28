import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FeedbackProcessingService } from '../../src/feedback-factory/processing/FeedbackProcessingService.ts';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.ts';
import { FeedbackDrainService } from '../../src/feedback-factory/drain/FeedbackDrainService.ts';
import { FeedbackInitiativeConsumer } from '../../src/feedback-factory/drain/FeedbackInitiativeConsumer.ts';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.ts';

const [dir] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const fd = fs.openSync(path.join(dir, 'feedback.jsonl'), 'w', 0o600);
try {
  const batch = [];
  for (let i = 0; i < 150_000; i++) {
    batch.push(JSON.stringify({
      feedbackId: `perf-${String(i).padStart(6, '0')}`, title: 'Repeated scheduler performance report',
      description: 'bounded performance evidence', type: 'bug', status: 'unprocessed',
      receivedAt: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`,
    }));
    if (batch.length === 2_000) { fs.writeSync(fd, `${batch.join('\n')}\n`); batch.length = 0; }
  }
  if (batch.length) fs.writeSync(fd, `${batch.join('\n')}\n`);
} finally { fs.closeSync(fd); }

const started = Date.now();
const processing = new FeedbackProcessingService({ dataDir: dir });
const store = new FeedbackDrainStore({ dbPath: path.join(dir, 'feedback-drain.db'), tokenHmacKey: 'k'.repeat(32) });
store.mutateAuthority({ action: 'create', operatorDecisionRef: 'perf', authorityId: 'authority', agentId: 'perf',
  ownerMachineId: 'perf-host', ownerEpoch: 1, provider: 'openai', modelFamily: 'gpt-5',
  promptVersion: 'feedback-readiness-v1', schemaVersion: 'feedback-readiness-decision-v1', decisionPointId: 'feedback-cluster-readiness',
  maxBatch: 50, maxTokens: 900, maxDailySpendUsd: 50 });
const arbiter = { decideBatch: async (_authority, candidates) => candidates.map((row) => ({
  clusterId: row.clusterId, outcome: 'ready', confidence: 0.99, reasonCodes: ['performance-fixture'],
  evidenceIds: row.evidenceIds, evidenceHash: 'e'.repeat(64),
})) };
for (const clusterId of ['oldest-eligible', 'newer-eligible']) {
  store.ensureReadiness(clusterId, 0);
  store.approveReady({ clusterId, approvalKey: `approval:${clusterId}`, authorityId: 'authority', authorityGeneration: 1,
    evidenceHash: 'e'.repeat(64), decisionNonce: `decision:${clusterId}:0001`, proposalSetHash: 'f'.repeat(64) });
  store.enqueue({ clusterId, title: clusterId, summary: 'fairness fixture', priority: 'normal', reportCount: 1,
    firstSeenAt: clusterId === 'oldest-eligible' ? 1 : 2, lastSeenAt: 2, authorityRef: 'authority:1', evidenceRef: `cluster:${clusterId}` });
}
const consumed = [];
const tracker = new InitiativeTracker(dir);
const productionConsumer = new FeedbackInitiativeConsumer(tracker);
const service = new FeedbackDrainService({ store, processing, consumer: { consume: async (work) => {
  consumed.push(work.feedbackWorkKey);
  return productionConsumer.consume(work);
} },
  arbiter, authorityId: 'authority', ownerHost: 'perf-host', ownerEpoch: () => 1, isCanonicalOwner: () => true,
  isConsumerLive: () => true, consumerBatchBound: () => 10, maxReadyScansPerTick: 250, maxClaimsPerTick: 10 });
const appendWorker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'feedback-performance-concurrent-ingest.mjs');
const viteNode = path.resolve('node_modules', '.bin', 'vite-node');
const concurrent = new Promise((resolve, reject) => {
  const child = spawn(viteNode, [appendWorker, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
});
const tick = await service.tick();
await concurrent;
const metrics = store.metrics();
process.stdout.write(JSON.stringify({
  processed: tick.processed, durationMs: Date.now() - started, tickResult: tick.result,
  rssBytes: process.memoryUsage().rss, sourceLagBytes: metrics.sourceProjectionLagBytes,
  projectionLag: processing.stats().byStatus.unprocessed ?? 0,
  queued: metrics.work.queued, completed: metrics.work.completed, wouldCreate: tick.wouldCreate, completedWithinTicks: consumed.includes('feedback-work:oldest-eligible:1') ? 1 : null,
  firstClaimedWorkKey: consumed[0] ?? null,
  authoritativeReadBack: Boolean(tracker.findByFeedbackWorkKey('feedback-work:oldest-eligible:1')),
}));
store.close();
