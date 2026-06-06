// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for the threadline-conversation journal kind (P3.1) —
 * THREADLINE-CONVERSATION-COHERENCE-SPEC §3.1/§3.2.
 *
 * Covers: typed-schema validation (free text rejected via unknown-field
 * counting, bad actions/ids refused); op-key dedupe; the ConversationStore
 * commit() transition-diff (started/bound/unbound/closed derived from
 * state+boundTopicId ONLY — a non-lifecycle commit emits NOTHING); the
 * mesh-view fold (own rows from the live store, replica last-writer fold
 * on the composite key, unbound clears the binding, staleness threading).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CoherenceJournal, type ThreadlineConversationData } from '../../src/core/CoherenceJournal.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { ConversationStore, type Conversation } from '../../src/threadline/ConversationStore.js';
import { buildMeshConversationView } from '../../src/threadline/ConversationMeshView.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-conv-kind-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('the journal kind — schema + dedupe (§3.1)', () => {
  function openJournal(): CoherenceJournal {
    const j = new CoherenceJournal({ stateDir: tmpDir, machineId: 'm_t', flushIntervalMs: 1_000_000 });
    j.open();
    return j;
  }

  it('emits + flushes a valid lifecycle entry; op-key dedupes a re-emit', () => {
    const j = openJournal();
    const d: ThreadlineConversationData = { action: 'started', conversationId: 'thread-1', peerFingerprint: 'fp-dawn', topicId: 42 };
    j.emitThreadlineConversation(d);
    j.emitThreadlineConversation(d); // op-key duplicate
    j.flush();
    const q = new CoherenceJournalReader({ stateDir: tmpDir }).query({ kind: 'threadline-conversation' });
    expect(q.entries).toHaveLength(1);
    expect(q.entries[0].data).toMatchObject({ action: 'started', conversationId: 'thread-1', peerFingerprint: 'fp-dawn', topicId: 42 });
    j.close();
  });

  it('refuses invalid actions and oversized ids (typed schema, free text excluded)', () => {
    const j = openJournal();
    j.emitThreadlineConversation({ action: 'renamed' as never, conversationId: 'x', peerFingerprint: 'fp' });
    j.emitThreadlineConversation({ action: 'started', conversationId: 'y'.repeat(300), peerFingerprint: 'fp' });
    j.emitThreadlineConversation({ action: 'started', conversationId: '', peerFingerprint: 'fp' });
    j.flush();
    const q = new CoherenceJournalReader({ stateDir: tmpDir }).query({ kind: 'threadline-conversation' });
    expect(q.entries).toHaveLength(0);
    j.close();
  });
});

describe('ConversationStore commit() transition-diff (§3.1)', () => {
  function makeStore(): { store: ConversationStore; emitted: ThreadlineConversationData[] } {
    const store = new ConversationStore(tmpDir);
    const emitted: ThreadlineConversationData[] = [];
    store.setCoherenceJournalSeam((d) => emitted.push(d as ThreadlineConversationData));
    return { store, emitted };
  }

  function draft(threadId: string, over: Partial<Conversation> = {}): Conversation {
    return {
      threadId,
      state: 'open',
      participants: { peers: ['fp-peer'] },
      version: 0,
      ...over,
    } as Conversation;
  }

  it('first commit emits started (+bound when born bound); a rebind emits unbound+bound; terminal emits closed', () => {
    const { store, emitted } = makeStore();
    store.mutateSync('t1', () => draft('t1', { boundTopicId: 5 }));
    expect(emitted.map((e) => e.action)).toEqual(['started', 'bound']);
    expect(emitted[1].topicId).toBe(5);

    emitted.length = 0;
    store.mutateSync('t1', (c) => ({ ...c, boundTopicId: 9 }));
    expect(emitted.map((e) => e.action)).toEqual(['unbound', 'bound']);
    expect(emitted[0].topicId).toBe(5); // unbound names the OLD topic
    expect(emitted[1].topicId).toBe(9);

    emitted.length = 0;
    store.mutateSync('t1', (c) => ({ ...c, state: 'resolved' as const }));
    expect(emitted.map((e) => e.action)).toEqual(['closed']);
  });

  it('a NON-lifecycle commit (message bump) emits NOTHING — the kind records lifecycle, never traffic', () => {
    const { store, emitted } = makeStore();
    store.mutateSync('t2', () => draft('t2'));
    emitted.length = 0;
    store.mutateSync('t2', (c) => ({ ...c, lastActivity: new Date().toISOString() } as Conversation));
    expect(emitted).toEqual([]);
  });

  it('a conversation without a peer fingerprint emits nothing (nothing coherent to record)', () => {
    const { store, emitted } = makeStore();
    store.mutateSync('t3', () => draft('t3', { participants: { peers: [] } } as Partial<Conversation>));
    expect(emitted).toEqual([]);
  });
});

describe('the mesh-view fold (§3.2)', () => {
  function writeReplica(machine: string, entries: Array<{ seq: number; ts: string; data: Record<string, unknown> }>): void {
    const dir = path.join(tmpDir, 'state', 'coherence-journal', 'peers');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${machine}.threadline-conversation.jsonl`),
      entries.map((e) => JSON.stringify({ seq: e.seq, ts: e.ts, machine, kind: 'threadline-conversation', ...(typeof e.data.topicId === 'number' ? { topic: e.data.topicId } : {}), data: e.data })).join('\n') + '\n',
    );
  }

  it('own rows from the live store; replica last-writer fold; unbound clears the binding; closed status', () => {
    const store = new ConversationStore(tmpDir);
    store.mutateSync('local-1', () => ({ threadId: 'local-1', state: 'active', participants: { peers: ['fp-codey'] }, boundTopicId: 7, version: 0 } as Conversation));

    writeReplica('m_mini', [
      { seq: 1, ts: '2026-06-06T00:00:01.000Z', data: { action: 'started', conversationId: 'remote-1', peerFingerprint: 'fp-dawn' } },
      { seq: 2, ts: '2026-06-06T00:00:02.000Z', data: { action: 'bound', conversationId: 'remote-1', peerFingerprint: 'fp-dawn', topicId: 99 } },
      { seq: 3, ts: '2026-06-06T00:00:03.000Z', data: { action: 'started', conversationId: 'remote-2', peerFingerprint: 'fp-x' } },
      { seq: 4, ts: '2026-06-06T00:00:04.000Z', data: { action: 'closed', conversationId: 'remote-2', peerFingerprint: 'fp-x' } },
    ]);

    const view = buildMeshConversationView({
      ownMachineId: 'm_laptop',
      ownConversations: store.all(),
      reader: new CoherenceJournalReader({ stateDir: tmpDir }),
    });
    const byId = Object.fromEntries(view.rows.map((r) => [`${r.holderMachineId}::${r.conversationId}`, r]));
    expect(byId['m_laptop::local-1']).toMatchObject({ kind: 'own', boundTopicId: 7, status: 'open', stalenessMs: 0 });
    expect(byId['m_mini::remote-1']).toMatchObject({ kind: 'replica', boundTopicId: 99, status: 'open', peerFingerprint: 'fp-dawn' });
    expect(byId['m_mini::remote-2']).toMatchObject({ kind: 'replica', status: 'closed' });
    expect(view.partial).toBe(false);
  });

  it('local scope (no reader) returns own rows only', () => {
    const store = new ConversationStore(tmpDir);
    store.mutateSync('only-local', () => ({ threadId: 'only-local', state: 'open', participants: { peers: ['fp'] }, version: 0 } as Conversation));
    writeReplica('m_mini', [{ seq: 1, ts: '2026-06-06T00:00:01.000Z', data: { action: 'started', conversationId: 'r', peerFingerprint: 'f' } }]);
    const view = buildMeshConversationView({ ownMachineId: 'm_laptop', ownConversations: store.all() });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].kind).toBe('own');
  });
});
