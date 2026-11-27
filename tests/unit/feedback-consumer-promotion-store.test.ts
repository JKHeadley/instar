import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackConsumerPromotionStore } from '../../src/feedback-factory/drain/FeedbackConsumerPromotionStore.js';
import { consumerPromotionSetHash } from '../../src/feedback-factory/drain/consumerPromotionProposal.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-consumer-promotion-store.test.ts' });
});

describe('FeedbackConsumerPromotionStore', () => {
  it('persists a mode-0600 bounded promotion and supports durable revocation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-promotion-')); dirs.push(dir);
    const file = path.join(dir, 'consumer-live.json');
    const store = new FeedbackConsumerPromotionStore(file);
    expect(store.isLive()).toBe(false);
    const ids = ['w-1', 'w-2', 'w-3'];
    const approvedAttempts = { 'w-1': 0, 'w-2': 0, 'w-3': 1 };
    const promoted = store.promote({ approvedBatchBound: 3, evidenceHash: consumerPromotionSetHash(ids), operatorDecisionId: 'decision-1', approvedWorkIds: ids, approvedAttempts });
    expect(promoted.approvedBatchBound).toBe(3);
    expect(store.isLive()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.approvedWorkIds()?.ids).toEqual(ids);
    expect(store.revoke().revokedAt).toBeTruthy();
    expect(store.isLive()).toBe(false);
    expect(store.approvedWorkIds()).toBeNull();
  });

  it('a record not bound to its approved ids never goes live (legacy or invented hash)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-promotion-')); dirs.push(dir);
    const store = new FeedbackConsumerPromotionStore(path.join(dir, 'consumer-live.json'));
    store.promote({ approvedBatchBound: 2, evidenceHash: 'a'.repeat(64), operatorDecisionId: 'legacy' });
    expect(store.read()).not.toBeNull();
    expect(store.isLive()).toBe(false);
    store.promote({ approvedBatchBound: 2, evidenceHash: 'a'.repeat(64), operatorDecisionId: 'invented', approvedWorkIds: ['x', 'y'] });
    expect(store.isLive()).toBe(false);
    store.promote({ approvedBatchBound: 2, evidenceHash: consumerPromotionSetHash(['x']), operatorDecisionId: 'short', approvedWorkIds: ['x', 'x'] });
    expect(store.isLive()).toBe(false);
    // A correct hash but missing or invalid attempt baselines is not live either.
    const prior = store.read();
    store.promote({ approvedBatchBound: 2, evidenceHash: consumerPromotionSetHash(['x', 'y'], `${prior!.recordNonce}|${prior!.approvedAt}|`), operatorDecisionId: 'no-baselines', approvedWorkIds: ['x', 'y'] });
    expect(store.isLive()).toBe(false);
  });

  it('fails closed on malformed or out-of-bound records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-promotion-')); dirs.push(dir);
    const file = path.join(dir, 'consumer-live.json');
    const store = new FeedbackConsumerPromotionStore(file);
    expect(() => store.promote({ approvedBatchBound: 51, evidenceHash: 'a'.repeat(64), operatorDecisionId: 'decision-1' })).toThrow(/1..50/);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, approvedBatchBound: 1, evidenceHash: 'not-a-hash', operatorDecisionId: 'x', approvedAt: 'now' }));
    expect(store.read()).toBeNull();
    expect(store.isLive()).toBe(false);
  });
});
