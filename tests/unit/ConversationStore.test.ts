/**
 * Unit tests for ConversationStore — Threadline Phase 1 keystone.
 *
 * Covers (spec acceptance criteria #1, #7, #9):
 *  - CRUD + lifecycle transitions on the Conversation record.
 *  - Single-writer CAS: N concurrent turnCount increments do NOT lose updates
 *    (the convergence-flagged race that silently defeated the turn budget).
 *  - Secondary lookups (participant, topicId, contextId with identity binding).
 *  - TTL / pinned / resolved-grace eviction parity with the legacy stores.
 *  - Ephemeral verified-only affinity (sliding + absolute windows).
 *  - Round-trip persistence (mutate → reload → fields + version preserved).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore, type Conversation } from '../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-store-'));
  return {
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ConversationStore.test.ts:cleanup' }),
  };
}

describe('ConversationStore', () => {
  let stateDir: string;
  let cleanup: () => void;

  beforeEach(() => { ({ stateDir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('upserts a new conversation via mutate at version 1 with defaults', async () => {
    const store = new ConversationStore(stateDir);
    const c = await store.mutate('t1', d => {
      d.participants.peers.push('peerFP');
      d.remoteAgent = 'codey';
      d.state = 'active';
      return d;
    });
    expect(c.threadId).toBe('t1');
    expect(c.version).toBe(1);
    expect(c.state).toBe('active');
    expect(c.participants.peers).toEqual(['peerFP']);
    expect(store.get('t1')?.remoteAgent).toBe('codey');
  });

  it('bumps version on each mutate and preserves prior fields', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t1', d => { d.subject = 's'; return d; });
    const c2 = await store.mutate('t1', d => { d.messageCount += 1; return d; });
    expect(c2.version).toBe(2);
    expect(c2.subject).toBe('s');
    expect(c2.messageCount).toBe(1);
  });

  it('CAS: 50 concurrent turnCount increments on one thread lose NO updates', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('loop', d => { d.state = 'active'; return d; });

    // Fire 50 increments concurrently. Under last-writer-wins (the legacy
    // load→mutate→persist) these would clobber each other and the final count
    // would be < 50, silently defeating the turn budget. The per-id queue +
    // CAS must serialize them to exactly 50.
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.mutate('loop', d => { d.turnCount += 1; return d; }),
      ),
    );
    expect(store.get('loop')?.turnCount).toBe(50);
  });

  it('CAS: interleaved async mutations on one thread still serialize', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t', d => { d.turnCount = 0; return d; });
    await Promise.all([
      store.mutate('t', async d => { await new Promise(r => setTimeout(r, 5)); d.turnCount += 10; return d; }),
      store.mutate('t', async d => { await new Promise(r => setTimeout(r, 1)); d.turnCount += 1; return d; }),
    ]);
    expect(store.get('t')?.turnCount).toBe(11);
  });

  it('rejects when the per-thread mutate queue exceeds max depth', async () => {
    const store = new ConversationStore(stateDir);
    // Enqueue many slow mutations so the queue backs up past 256.
    const slow = () => store.mutate('q', async d => { await new Promise(r => setTimeout(r, 0)); return d; });
    const promises: Promise<unknown>[] = [];
    let rejected = false;
    for (let i = 0; i < 300; i++) {
      promises.push(slow().catch(() => { rejected = true; }));
    }
    await Promise.all(promises);
    expect(rejected).toBe(true);
  });

  it('looks up by participant', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t1', d => { d.participants.peers.push('alice'); return d; });
    await store.mutate('t2', d => { d.participants.peers.push('bob'); return d; });
    expect(store.getByParticipant('alice').map(c => c.threadId)).toEqual(['t1']);
    expect(store.getByParticipant('nobody')).toEqual([]);
  });

  it('looks up by bound topic id', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t1', d => { d.boundTopicId = 42; return d; });
    expect(store.getByTopicId(42)?.threadId).toBe('t1');
    expect(store.getByTopicId(99)).toBeNull();
  });

  it('contextId lookup enforces identity binding (session-smuggling guard)', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t1', d => { d.contextId = 'ctx-1'; d.agentIdentity = 'owner'; return d; });
    expect(store.getByContextId('ctx-1', 'owner')?.threadId).toBe('t1');
    // A different agent presenting the same contextId is refused.
    expect(store.getByContextId('ctx-1', 'attacker')).toBeNull();
  });

  it('TTL: a stale non-pinned conversation reads as null; pinned survives', async () => {
    const store = new ConversationStore(stateDir);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await store.mutate('stale', d => { d.lastActivityAt = old; return d; });
    await store.mutate('pinnedStale', d => { d.lastActivityAt = old; d.pinned = true; return d; });
    expect(store.get('stale')).toBeNull();
    expect(store.get('pinnedStale')?.threadId).toBe('pinnedStale');
  });

  it('resolved conversations survive within the grace period', async () => {
    const store = new ConversationStore(stateDir);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await store.mutate('r', d => {
      d.lastActivityAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      d.state = 'resolved';
      d.resolvedAt = recent;
      return d;
    });
    expect(store.get('r')?.state).toBe('resolved');
  });

  it('ephemeral affinity honors the sliding window and is non-durable', async () => {
    const store = new ConversationStore(stateDir);
    store.recordAffinity('peerX', 'tX');
    expect(store.getAffinity('peerX')).toBe('tX');
    // A brand-new store (simulating a restart) has no affinity — accepted loss.
    const restarted = new ConversationStore(stateDir);
    expect(restarted.getAffinity('peerX')).toBeNull();
  });

  it('round-trips through disk: reload preserves fields + version', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t1', d => {
      d.sessionUuid = 'uuid-123';
      d.boundTopicId = 7;
      d.agentIdentity = 'me';
      d.pinned = true;
      d.turnCount = 4;
      d.state = 'awaiting-reply';
      return d;
    });
    const reloaded = new ConversationStore(stateDir);
    const c = reloaded.get('t1')!;
    expect(c.sessionUuid).toBe('uuid-123');
    expect(c.boundTopicId).toBe(7);
    expect(c.agentIdentity).toBe('me');
    expect(c.turnCount).toBe(4);
    expect(c.state).toBe('awaiting-reply');
    expect(c.version).toBe(1);
  });

  it('importDirect (migration path) bypasses CAS and flush persists', () => {
    const store = new ConversationStore(stateDir);
    const conv: Conversation = {
      threadId: 'm1', version: 3, participants: { peers: ['p'] }, state: 'idle',
      pinned: false, messageCount: 2, turnCount: 1,
      createdAt: new Date().toISOString(), savedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    store.importDirect(conv);
    store.flush();
    const reloaded = new ConversationStore(stateDir);
    expect(reloaded.get('m1')?.version).toBe(3);
    expect(reloaded.get('m1')?.state).toBe('idle');
  });

  it('listActive excludes resolved/failed/archived', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('a', d => { d.state = 'active'; return d; });
    await store.mutate('b', d => { d.state = 'resolved'; d.resolvedAt = new Date().toISOString(); return d; });
    await store.mutate('c', d => { d.state = 'archived'; return d; });
    expect(store.listActive().map(c => c.threadId).sort()).toEqual(['a']);
  });

  it('retires stale non-pinned active and idle conversations without deleting them', async () => {
    const store = new ConversationStore(stateDir);
    // TIME-BOMB GUARD: `now` must be the REAL current time, not a pinned date.
    // The store's commit() path prunes non-pinned conversations older than
    // MAX_AGE_MS (7d) against the REAL clock — with a pinned now, the backdated
    // records cross that horizon once the calendar moves far enough past the
    // pinned date and get PRUNED before retireInactive ever sees them (this test
    // detonated on 2026-06-05, exactly 7 days after its pinned 2026-05-29 data).
    const now = new Date();
    const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

    await store.mutate('stale-active', d => { d.state = 'active'; d.lastActivityAt = stale; return d; });
    await store.mutate('stale-idle', d => { d.state = 'idle'; d.lastActivityAt = stale; return d; });
    await store.mutate('fresh-active', d => { d.state = 'active'; d.lastActivityAt = fresh; return d; });
    await store.mutate('pinned-stale', d => { d.state = 'active'; d.lastActivityAt = stale; d.pinned = true; return d; });

    expect(store.retireInactive(24 * 60 * 60 * 1000, now)).toBe(2);
    expect(store.get('stale-active')?.state).toBe('archived');
    expect(store.get('stale-idle')?.state).toBe('archived');
    expect(store.get('fresh-active')?.state).toBe('active');
    expect(store.get('pinned-stale')?.state).toBe('active');
    expect(store.listActive().map(c => c.threadId).sort()).toEqual(['fresh-active', 'pinned-stale']);
  });

  it('CROSS-PROCESS: two store instances on one file lose no same-thread update', async () => {
    // Phase 2a: disk-backed per-record version-CAS — two instances (simulating
    // the server + the MCP child) mutating the SAME thread must not clobber.
    const a = new ConversationStore(stateDir);
    const b = new ConversationStore(stateDir);
    await a.mutate('shared', d => { d.state = 'active'; d.turnCount = 0; return d; });
    await Promise.all([
      ...Array.from({ length: 25 }, () => a.mutate('shared', d => { d.turnCount += 1; return d; })),
      ...Array.from({ length: 25 }, () => b.mutate('shared', d => { d.turnCount += 1; return d; })),
    ]);
    expect(new ConversationStore(stateDir).get('shared')?.turnCount).toBe(50);
  });

  it('mutateSync racing async mutate loses no update (both bump version)', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('t', d => { d.turnCount = 0; d.messageCount = 0; return d; });
    await Promise.all([
      store.mutate('t', async d => { await new Promise(r => setTimeout(r, 3)); d.turnCount += 1; return d; }),
      (async () => { store.mutateSync('t', d => { d.messageCount += 1; return d; }); })(),
      store.mutate('t', d => { d.turnCount += 1; return d; }),
      (async () => { store.mutateSync('t', d => { d.messageCount += 1; return d; }); })(),
    ]);
    const c = new ConversationStore(stateDir).get('t')!;
    expect(c.turnCount).toBe(2);
    expect(c.messageCount).toBe(2);
  });

  it('mutateSync returning null deletes the record', () => {
    const store = new ConversationStore(stateDir);
    store.mutateSync('gone', d => { d.state = 'active'; return d; });
    expect(store.get('gone')?.state).toBe('active');
    expect(store.mutateSync('gone', () => null)).toBeNull();
    expect(new ConversationStore(stateDir).get('gone')).toBeNull();
  });

  it('a write by one instance is visible to a fresh instance (disk is source of truth)', async () => {
    const a = new ConversationStore(stateDir);
    await a.mutate('x', d => { d.subject = 'hello'; return d; });
    expect(new ConversationStore(stateDir).get('x')?.subject).toBe('hello');
  });
});
