/**
 * ConversationStore — Robustness Phase 2 additions: close-only log retention
 * (SA5), the verified-only resolver binding (D-E), the saturating collision
 * counter, and the coalesced head-cache stamp.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convstore-p2-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ConversationStore-canonicalHistory.test.ts' }); } catch { /* ignore */ } });

describe('ConversationStore — close-only log retention (SA5)', () => {
  it('fires the retention seam on resolved/failed but NOT on cold archive, LRU, or pinned', async () => {
    const store = new ConversationStore(dir);
    const deleted: string[] = [];
    store.setLogRetentionSeam((tid) => deleted.push(tid));

    // resolved → fires
    await store.mutate('thread-resolved', (d) => { d.participants.peers = ['fp-peer']; d.state = 'active'; return d; });
    await store.mutate('thread-resolved', (d) => { d.state = 'resolved'; return d; });
    expect(deleted).toContain('thread-resolved');

    // failed → fires
    await store.mutate('thread-failed', (d) => { d.state = 'failed'; return d; });
    expect(deleted).toContain('thread-failed');

    // archived (cold/inactivity retire) → does NOT fire (keeps a live relationship's history)
    await store.mutate('thread-archived', (d) => { d.state = 'active'; return d; });
    await store.mutate('thread-archived', (d) => { d.state = 'archived'; return d; });
    expect(deleted).not.toContain('thread-archived');

    // pinned + resolved → does NOT fire
    await store.mutate('thread-pinned', (d) => { d.pinned = true; d.state = 'active'; return d; });
    await store.mutate('thread-pinned', (d) => { d.state = 'resolved'; return d; });
    expect(deleted).not.toContain('thread-pinned');
  });

  it('retireInactive (→ archived) never fires the retention seam', async () => {
    const store = new ConversationStore(dir);
    const deleted: string[] = [];
    store.setLogRetentionSeam((tid) => deleted.push(tid));
    await store.mutate('thread-stale', (d) => {
      d.state = 'active';
      d.lastActivityAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      return d;
    });
    const n = store.retireInactive(24 * 60 * 60 * 1000);
    expect(n).toBe(1);
    expect(deleted).not.toContain('thread-stale');
  });
});

describe('ConversationStore — resolver binding (D-E, verified-only)', () => {
  it('binds + resolves the canonical thread for a (peerPrincipal, workstreamKey)', async () => {
    const store = new ConversationStore(dir);
    expect(store.resolveCanonicalThread('fp-A', 'cutover')).toEqual({ kind: 'none' });
    await store.bindCanonicalThread('thread-1', 'fp-A', 'cutover');
    expect(store.resolveCanonicalThread('fp-A', 'cutover')).toEqual({ kind: 'found', threadId: 'thread-1' });
  });

  it('never merges across DIFFERENT peers or DIFFERENT workstream keys', async () => {
    const store = new ConversationStore(dir);
    await store.bindCanonicalThread('thread-1', 'fp-A', 'cutover');
    expect(store.resolveCanonicalThread('fp-B', 'cutover')).toEqual({ kind: 'none' }); // different peer
    expect(store.resolveCanonicalThread('fp-A', 'other')).toEqual({ kind: 'none' });   // different workstream
  });

  it('first-write-wins: a second thread does NOT steal an existing binding', async () => {
    const store = new ConversationStore(dir);
    await store.bindCanonicalThread('thread-1', 'fp-A', 'cutover');
    await store.bindCanonicalThread('thread-2', 'fp-A', 'cutover');
    expect(store.resolveCanonicalThread('fp-A', 'cutover')).toEqual({ kind: 'found', threadId: 'thread-1' });
  });
});

describe('ConversationStore — collision counter + head cache', () => {
  it('collision counter saturates at the ceiling (anti write-amplification)', async () => {
    const store = new ConversationStore(dir);
    for (let i = 0; i < 5; i++) await store.recordCollision('thread-x');
    expect(store.get('thread-x')?.collisionCount).toBe(5);
  });

  it('stampHistoryHead persists the coalesced head cache', async () => {
    const store = new ConversationStore(dir);
    await store.stampHistoryHead('thread-y', { count: 3, headHash: 'abc', setAccum: 'f'.repeat(64) });
    const c = store.get('thread-y');
    expect(c?.historyCount).toBe(3);
    expect(c?.historyHeadHash).toBe('abc');
    expect(c?.historySetAccum).toBe('f'.repeat(64));
  });

  it('stampBackfilled marks + clears the one-time backfill memo', async () => {
    const store = new ConversationStore(dir);
    await store.stampBackfilled('thread-z', true);
    expect(store.get('thread-z')?.backfilled).toBe(true);
  });
});
