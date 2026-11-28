import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryAcquisitionStore, type ExportAccount } from '../../src/import/HistoryAcquisition.js';

const chat = { owner: 'owner-1', machine: 'studio', conversation: 'app:abc' };
const account: ExportAccount = { provider: 'chatgpt', profileId: 'pilot', expectedEmail: 'Person@example.test', workspace: 'personal' };

describe('history acquisition recovery', () => {
  let dir: string, now: number, store: HistoryAcquisitionStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquire-')); now = Date.now();
    store = new HistoryAcquisitionStore(dir, () => now);
  });
  afterEach(() => { store.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'cleanup history acquisition test' }); });
  it('recovers uncertain submission without authorizing another click', () => {
    const { id } = store.start(chat, account, 'one');
    expect(store.reserveSubmission(chat, id)).toBe(true);
    store.close(); store = new HistoryAcquisitionStore(dir, () => now);
    expect(store.start(chat, account, 'two').phase).toBe('submitting');
    expect(store.reserveSubmission(chat, id)).toBe(false);
    expect(store.acknowledge(chat, id)).toBe(true);
    expect(store.claimObservation(chat, id)).toBe(true);
    expect(store.claimObservation(chat, id)).toBe(false);
    now += 15 * 60000; expect(store.claimObservation(chat, id)).toBe(true);
  });
  it('keeps requests and cancellations in the original owner chat on the original machine', () => {
    const { id } = store.start(chat, account, 'tap');
    expect(() => store.start({ ...chat, conversation: 'another' }, account, 'new')).toThrow('account-export-in-progress');
    expect(() => store.start(chat, { ...account, provider: 'claude' }, 'second-provider')).toThrow('conversation-export-in-progress');
    for (const scope of [{ ...chat, owner: 'someone' }, { ...chat, machine: 'laptop' }, { ...chat, conversation: 'another' }]) {
      expect(store.read(scope, id)).toBeUndefined();
      expect(store.reserveSubmission(scope, id)).toBe(false);
      expect(store.cancel(scope, id)).toBe(false);
    }
    expect(store.cancel(chat, id)).toBe(true);
    expect(store.start(chat, account, 'tap').phase).toBe('cancelled');
    expect(store.review(chat, id, 'a'.repeat(64))).toBe(false);
    expect(store.start(chat, account, 'next').id).not.toBe(id);
    expect(() => store.start(chat, { ...account, expectedEmail: 'other@example.test' }, 'tap')).toThrow('request-id-conflict');
  });
  it('recognizes a correlated delivery while provider confirmation is unknown, and expires old jobs', () => {
    const { id } = store.start(chat, account, 'one');
    expect(store.review(chat, id, 'a'.repeat(64))).toBe(false);
    store.reserveSubmission(chat, id);
    expect(store.review(chat, id, 'a'.repeat(64))).toBe(true);
    now += 8 * 86400000;
    expect(store.read(chat, id)?.phase).toBe('expired');
    expect(store.start(chat, account, 'new').id).not.toBe(id);
  });

  it('cleans up a partial apply that failed after the deadline without waiting for a restart', () => {
    const { id } = store.start(chat, account, 'one');
    store.reserveSubmission(chat, id);
    const digest = 'a'.repeat(64);
    store.review(chat, id, digest);
    store.beginApply(chat, id, digest);
    now += 8 * 86400000;
    expect(store.keepArchive(id)).toBe(true);
    expect(store.requestReviewAfterInterruptedApply(chat, id)).toBe(true);
    expect(store.read(chat, id)?.phase).toBe('expired');
    expect(store.keepArchive(id)).toBe(false);
  });

  it('preserves a single rejection notice and the reason across a restart', () => {
    const { id } = store.start(chat, account, 'one');
    store.reserveSubmission(chat, id);
    store.rejectArchive(chat, id);
    store.close();
    store = new HistoryAcquisitionStore(dir, () => now);
    store.restoreNotices();
    store.rejectArchive(chat, id);
    const job = store.read(chat, id)!;
    expect([job.phase, store.attentionFor(job), store.keepArchive(id)]).toEqual(['cancelled', 'invalid-archive', false]);
    const pending = store.pendingNotices();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ ...chat, id, lastKind: 'rejected' });
    store.delivered(id, pending[0].sequence);
    expect(store.pendingNotices()).toHaveLength(0);
  });
});
