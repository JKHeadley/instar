/**
 * recordThreadMessage unit tests (D-B funnel + D-E resolver).
 *
 * Funnel: identity-free digest recomputed locally; a disagreeing wire digest is
 * flagged but never enters the chain; collision recorded; head-cache coalesced;
 * append-failure raises ONE deduped Attention item. Resolver: the join-vs-fork
 * matrix, dry-run vs enforce, never-merge-across-peers, lookup-failure does not
 * mint a fresh canonical.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';

// canonical-migration-validator: threadline-inbound-canonical-store@1
import os from 'node:os';
import path from 'node:path';
import { ThreadLog } from '../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { ThreadMessageRecorder, recordThreadMessage } from '../../src/threadline/recordThreadMessage.js';
import { contentDigest } from '../../src/threadline/threadDigest.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let threadLog: ThreadLog;
let store: ConversationStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-'));
  threadLog = new ThreadLog(dir);
  store = new ConversationStore(dir);
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/recordThreadMessage.test.ts' }); } catch { /* ignore */ } });

function recorder(extra: Partial<ConstructorParameters<typeof ThreadMessageRecorder>[0]> = {}) {
  return new ThreadMessageRecorder({ threadLog, conversationStore: store, logDir: path.join(dir, 'logs'), headCacheCoalesceMs: 5, ...extra });
}

describe('recordThreadMessage — funnel', () => {
  it('recomputes the identity-free digest locally and appends', () => {
    const r = recorder();
    const res = recordThreadMessage(r, { threadId: 'thread-a', messageId: 'm1', direction: 'outbound', body: 'hello', createdAt: '2026-06-12T00:00:00.000Z' });
    expect(res.status).toBe('appended');
    expect(res.contentDigest).toBe(contentDigest({ threadId: 'thread-a', messageId: 'm1', body: 'hello', createdAt: '2026-06-12T00:00:00.000Z' }));
    expect(threadLog.read('thread-a').entries.length).toBe(1);
  });

  it('a DISAGREEING wire digest is flagged but the LOCAL digest enters the chain', () => {
    const r = recorder();
    const res = recordThreadMessage(r, {
      threadId: 'thread-b', messageId: 'm1', direction: 'inbound', body: 'hi', createdAt: '2026-06-12T00:00:00.000Z',
      wireDigest: 'deadbeef'.repeat(8), // attacker-supplied, wrong
    });
    expect(res.wireDigestMismatch).toBe(true);
    // The chain holds the LOCALLY-computed digest, never the wire one.
    expect(threadLog.read('thread-b').entries[0].contentDigest).toBe(res.contentDigest);
    expect(threadLog.read('thread-b').entries[0].contentDigest).not.toBe('deadbeef'.repeat(8));
  });

  it('a duplicate is idempotent; a same-id-different-content replay is a recorded collision', async () => {
    const r = recorder();
    const base = { threadId: 'thread-c', messageId: 'm1', direction: 'outbound' as const, createdAt: '2026-06-12T00:00:00.000Z' };
    expect(recordThreadMessage(r, { ...base, body: 'one' }).status).toBe('appended');
    expect(recordThreadMessage(r, { ...base, body: 'one' }).status).toBe('duplicate');
    expect(recordThreadMessage(r, { ...base, body: 'POISON' }).status).toBe('collision');
    // The collision is recorded on the conversation (saturating) and not appended.
    await new Promise((res) => setTimeout(res, 10));
    expect(store.get('thread-c')?.collisionCount).toBe(1);
    expect(threadLog.read('thread-c').entries.length).toBe(1);
  });

  it('coalesced head-cache is stamped on the conversation after flush', async () => {
    const r = recorder();
    recordThreadMessage(r, { threadId: 'thread-d', messageId: 'm1', direction: 'outbound', body: 'a', createdAt: '2026-06-12T00:00:00.000Z' });
    recordThreadMessage(r, { threadId: 'thread-d', messageId: 'm2', direction: 'inbound', body: 'b', createdAt: '2026-06-12T00:00:01.000Z' });
    await r.flushPending();
    const c = store.get('thread-d');
    expect(c?.historyCount).toBe(2);
    expect(c?.historyHeadHash).toBe(threadLog.head('thread-d').headHash);
    expect(c?.historySetAccum).toBe(threadLog.head('thread-d').setAccum);
  });

  it('N consecutive append failures raise ONE deduped Attention item (FD-1)', () => {
    const raised: string[] = [];
    // A ThreadLog whose append always throws (simulated FS failure).
    const failingLog = { append: () => { throw new Error('ENOSPC'); }, head: () => ({ count: 0, headHash: '', setAccum: '0'.repeat(64) }) } as unknown as ThreadLog;
    const r = new ThreadMessageRecorder({
      threadLog: failingLog, conversationStore: store, appendFailureAlertThreshold: 3,
      attention: { createAttentionItem: (i) => { raised.push(i.id); return i; } },
    });
    for (let i = 0; i < 5; i++) {
      const res = recordThreadMessage(r, { threadId: 'thread-e', messageId: `m${i}`, direction: 'outbound', body: 'x', createdAt: '2026-06-12T00:00:00.000Z' });
      expect(res.status).toBe('append-failed');
    }
    // The dedup id is stable → at most one distinct Attention item for the thread.
    expect(new Set(raised).size).toBe(1);
    expect(raised[0]).toBe('threadline-canonical-append-fail:thread-e');
  });
});

describe('recordThreadMessage — resolver (D-E) matrix', () => {
  const PEER = 'fp-peer-aaaa';
  const base = { mintedThreadId: 'uuid-new', enabled: true, dryRun: false, workstreamKeyMode: 'subject-slug' as const, peerPrincipal: PEER };

  it('resolver OFF (disabled / no principal) → mint as today', async () => {
    const r = recorder();
    expect((await r.resolveOutboundThread({ ...base, enabled: false, subject: 's' })).decision).toBe('resolver-off');
    expect((await r.resolveOutboundThread({ ...base, peerPrincipal: undefined, subject: 's' })).decision).toBe('resolver-off');
  });

  it('explicit threadId → used verbatim (no resolver)', async () => {
    const r = recorder();
    const res = await r.resolveOutboundThread({ ...base, explicitThreadId: 'thread-existing', subject: 's' });
    expect(res).toMatchObject({ threadId: 'thread-existing', decision: 'explicit-threadid' });
  });

  it('no binding → mints + becomes canonical; a later send JOINS (enforce)', async () => {
    const r = recorder();
    const first = await r.resolveOutboundThread({ ...base, subject: 'feedback cutover' });
    expect(first).toMatchObject({ threadId: 'uuid-new', decision: 'minted:no-binding' });
    const second = await r.resolveOutboundThread({ ...base, mintedThreadId: 'uuid-2', subject: 'Feedback Cutover!' });
    expect(second).toMatchObject({ threadId: 'uuid-new', decision: 'joined:existing-binding' });
  });

  it('DRY-RUN join logs would-join but still mints as today (no reroute)', async () => {
    const r = recorder();
    await r.resolveOutboundThread({ ...base, subject: 'cutover' }); // binds uuid-new
    const dry = await r.resolveOutboundThread({ ...base, mintedThreadId: 'uuid-2', dryRun: true, subject: 'cutover' });
    expect(dry).toMatchObject({ threadId: 'uuid-2', decision: 'would-join:existing-binding', wouldJoin: 'uuid-new' });
  });

  it('explicit FORK → mints, never steals the canonical', async () => {
    const r = recorder();
    await r.resolveOutboundThread({ ...base, subject: 'cutover' });
    const forked = await r.resolveOutboundThread({ ...base, mintedThreadId: 'uuid-fork', fork: true, subject: 'cutover' });
    expect(forked).toMatchObject({ threadId: 'uuid-fork', decision: 'minted:fork-requested' });
    // The canonical binding still points at the original.
    expect(store.resolveCanonicalThread(PEER, 'cutover')).toEqual({ kind: 'found', threadId: 'uuid-new' });
  });

  it('NEVER merges across different peers or workstream keys', async () => {
    const r = recorder();
    await r.resolveOutboundThread({ ...base, subject: 'cutover' }); // peer A / cutover → uuid-new
    const otherPeer = await r.resolveOutboundThread({ ...base, mintedThreadId: 'uuid-b', peerPrincipal: 'fp-other', subject: 'cutover' });
    expect(otherPeer.decision).toBe('minted:no-binding'); // different peer → own canonical
    const otherWork = await r.resolveOutboundThread({ ...base, mintedThreadId: 'uuid-c', subject: 'different topic' });
    expect(otherWork.decision).toBe('minted:no-binding'); // different workstream → own canonical
  });

  it('the dry-run decision log records each decision line', async () => {
    const r = recorder();
    await r.resolveOutboundThread({ ...base, dryRun: true, subject: 'cutover' });
    const logPath = path.join(dir, 'logs', 'threadline-canonical-history.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0]).decision).toBe('minted:no-binding');
  });
});
