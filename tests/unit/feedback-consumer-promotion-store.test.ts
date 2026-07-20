import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackConsumerPromotionStore } from '../../src/feedback-factory/drain/FeedbackConsumerPromotionStore.js';

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
    const promoted = store.promote({ approvedBatchBound: 3, evidenceHash: 'a'.repeat(64), operatorDecisionId: 'decision-1' });
    expect(promoted.approvedBatchBound).toBe(3);
    expect(store.isLive()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.revoke().revokedAt).toBeTruthy();
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
