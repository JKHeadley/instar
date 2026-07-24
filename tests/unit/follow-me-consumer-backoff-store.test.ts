import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FollowMeConsumerBackoffStore,
  classifyFollowMeFailure,
  followMeBackoffKey,
} from '../../src/coordination/FollowMeConsumerBackoffStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-me-backoff-'));
  dirs.push(dir);
  return { dir, store: new FollowMeConsumerBackoffStore(dir) };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'follow-me-backoff-test' });
  }
});

describe('FollowMeConsumerBackoffStore', () => {
  it('uses 1m/5m/15m then parks one durable pair episode', () => {
    const { dir, store } = make();
    const key = followMeBackoffKey('account-a', 'machine-b');
    const t0 = Date.parse('2026-07-23T00:00:00.000Z');

    expect(store.shouldAttempt(key, t0)).toBe(true);
    expect(store.recordFailure(key, 'identity', t0)).toMatchObject({ attempts: 1, parkedAt: null });
    expect(store.shouldAttempt(key, t0 + 59_999)).toBe(false);
    expect(store.shouldAttempt(key, t0 + 60_000)).toBe(true);
    store.recordFailure(key, 'identity', t0 + 60_000);
    store.recordFailure(key, 'other', t0 + 6 * 60_000);
    const parked = store.recordFailure(key, 'other', t0 + 21 * 60_000);
    expect(parked).toMatchObject({ attempts: 4, lane: 'identity' });
    expect(parked.parkedAt).not.toBeNull();

    const reloaded = new FollowMeConsumerBackoffStore(dir);
    expect(reloaded.shouldAttempt(key, t0 + 365 * 24 * 60 * 60_000)).toBe(false);
  });

  it('clears an episode only after success', () => {
    const { store } = make();
    const key = followMeBackoffKey('a', 'm');
    store.recordFailure(key, 'other', 0);
    store.clear(key);
    expect(store.shouldAttempt(key, 0)).toBe(true);
  });

  it('starts one fresh bounded episode only when causal evidence changes', () => {
    const { store } = make();
    const key = followMeBackoffKey('a', 'm');
    const missing = {
      identityEvidenceKey: 'missing',
      identityResolved: false,
      authoritySetKey: 'mandate-1',
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      store.recordFailure(key, 'identity', attempt * 1_000, missing, 'account-record-missing-email');
    }
    expect(store.shouldAttempt(key, 99_000, missing)).toBe(false);
    expect(store.shouldAttempt(key, 99_000, { ...missing, authoritySetKey: 'mandate-2' })).toBe(false);
    expect(store.shouldAttempt(key, 99_000, {
      identityEvidenceKey: 'conflict:a@example.com,b@example.com',
      identityResolved: false,
      authoritySetKey: 'mandate-2',
    })).toBe(false);
    expect(store.shouldAttempt(key, 99_000, {
      identityEvidenceKey: 'resolved:a@example.com',
      identityResolved: true,
      authoritySetKey: 'mandate-2',
    })).toBe(true);
    expect(store.get(key)).toBeNull();
  });

  it('wakes a parked non-identity episode only for changed authority', () => {
    const { store } = make();
    const key = followMeBackoffKey('a', 'm');
    const evidence = {
      identityEvidenceKey: 'resolved:a@example.com',
      identityResolved: true,
      authoritySetKey: 'mandate-1',
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      store.recordFailure(key, 'other', attempt * 1_000, evidence, 'mandate-refused');
    }
    expect(store.shouldAttempt(key, 99_000, {
      ...evidence,
      identityEvidenceKey: 'resolved:new@example.com',
    })).toBe(false);
    expect(store.shouldAttempt(key, 99_000, { ...evidence, authoritySetKey: 'mandate-2' })).toBe(true);
  });

  it('classifies the honest identity 409s', () => {
    expect(classifyFollowMeFailure(409, 'account-record-missing-email')).toBe('identity');
    expect(classifyFollowMeFailure(409, 'account-record-email-conflict')).toBe('identity');
    expect(classifyFollowMeFailure(409, 'something-else')).toBe('other');
  });
});
