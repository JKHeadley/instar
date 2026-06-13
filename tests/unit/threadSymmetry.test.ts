/**
 * threadSymmetry unit tests (D-D) — state machine, participant-authorized
 * honor/serve, untrusted ingest (SA4), and the terminating episode (SA2).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadLog } from '../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { ThreadMessageRecorder } from '../../src/threadline/recordThreadMessage.js';
import {
  computeSymmetryState,
  honorPeerThreadSync,
  serveBackfill,
  ingestBackfill,
  localThreadSync,
  type SymmetryDeps,
} from '../../src/threadline/threadSymmetry.js';
import { contentDigest, DIGEST_VERSION } from '../../src/threadline/threadDigest.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
let threadLog: ThreadLog;
let store: ConversationStore;
let recorder: ThreadMessageRecorder;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symmetry-'));
  threadLog = new ThreadLog(dir);
  store = new ConversationStore(dir);
  recorder = new ThreadMessageRecorder({ threadLog, conversationStore: store, headCacheCoalesceMs: 1 });
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadSymmetry.test.ts' }); } catch { /* ignore */ } });

const PEER = 'fp-peer-1111';
const E = '0'.repeat(64);

function deps(extra: Partial<SymmetryDeps> = {}): SymmetryDeps {
  return { threadLog, conversationStore: store, threadMessageRecorder: recorder, ...extra };
}

async function seed(threadId: string, peer = PEER) {
  recorder.record({ threadId, messageId: 'm1', direction: 'outbound', body: 'a', createdAt: '2026-06-12T00:00:00.000Z', peerFingerprint: peer });
  recorder.record({ threadId, messageId: 'm2', direction: 'inbound', body: 'b', createdAt: '2026-06-12T00:00:01.000Z', peerFingerprint: peer });
  await store.mutate(threadId, (d) => { d.participants.peers = [peer]; return d; });
}

describe('computeSymmetryState — closed set', () => {
  it('verified / diverged / version-skew / unverified-backfill / local-integrity-fault / legacy', () => {
    const base = { localCount: 2, localSetAccum: 'aa', hasBackfilled: false, localVerifyOk: true };
    expect(computeSymmetryState({ ...base, peerSync: { digestVersion: 1, count: 2, setAccum: 'aa' } })).toBe('verified');
    expect(computeSymmetryState({ ...base, peerSync: { digestVersion: 1, count: 2, setAccum: 'bb' } })).toBe('diverged');
    expect(computeSymmetryState({ ...base, peerSync: { digestVersion: 9, count: 2, setAccum: 'aa' } })).toBe('version-skew');
    expect(computeSymmetryState({ ...base, hasBackfilled: true, peerSync: { digestVersion: 1, count: 2, setAccum: 'aa' } })).toBe('unverified-backfill');
    expect(computeSymmetryState({ ...base, localVerifyOk: false, peerSync: { digestVersion: 1, count: 2, setAccum: 'aa' } })).toBe('local-integrity-fault');
    expect(computeSymmetryState({ ...base, peerSync: null, peerEverReported: false })).toBe('unverified-peer-legacy');
    expect(computeSymmetryState({ ...base, sticky: true, peerSync: { digestVersion: 1, count: 2, setAccum: 'aa' } })).toBe('diverged-unreconcilable');
  });
});

describe('honorPeerThreadSync — participant-scoped + monotonic', () => {
  it('verified when the peer head matches; drops a non-participant report', async () => {
    await seed('t-1');
    const head = threadLog.head('t-1');
    expect(await honorPeerThreadSync(deps(), 't-1', PEER, { digestVersion: DIGEST_VERSION, count: head.count, setAccum: head.setAccum })).toBe('verified');
    // A non-participant fingerprint is dropped (never surfaced).
    expect(await honorPeerThreadSync(deps(), 't-1', 'fp-stranger', { digestVersion: DIGEST_VERSION, count: head.count, setAccum: head.setAccum })).toBe('unknown');
  });

  it('a stale (lower-count) replayed report does not regress the view', async () => {
    await seed('t-2');
    const head = threadLog.head('t-2');
    await honorPeerThreadSync(deps(), 't-2', PEER, { digestVersion: DIGEST_VERSION, count: head.count, setAccum: head.setAccum });
    // A replay with a LOWER count is ignored (monotonic guard).
    const after = await honorPeerThreadSync(deps(), 't-2', PEER, { digestVersion: DIGEST_VERSION, count: 0, setAccum: E });
    expect(after).toBe('verified');
  });
});

describe('serveBackfill — participant-authorized (SA1)', () => {
  it('serves records to a participant; returns EMPTY to a non-participant (exfiltration block)', async () => {
    await seed('t-3');
    const cd = contentDigest({ threadId: 't-3', messageId: 'm1', body: 'a', createdAt: '2026-06-12T00:00:00.000Z' });
    expect(serveBackfill(deps(), 't-3', PEER, [cd]).length).toBe(1);
    // A verified-but-NON-participant peer naming this thread gets EMPTY.
    expect(serveBackfill(deps(), 't-3', 'fp-attacker', [cd])).toEqual([]);
  });
});

describe('ingestBackfill — untrusted (SA4)', () => {
  it('drops a record whose recomputed digest was NOT requested', () => {
    const requested = new Set([contentDigest({ threadId: 't-4', messageId: 'm9', body: 'wanted', createdAt: '2026-06-12T00:00:00.000Z' })]);
    const res = ingestBackfill(deps(), 't-4', PEER, [
      { messageId: 'm9', body: 'wanted', createdAt: '2026-06-12T00:00:00.000Z', direction: 'inbound' },
      { messageId: 'mX', body: 'UNREQUESTED', createdAt: '2026-06-12T00:00:00.000Z', direction: 'inbound' },
    ], requested);
    expect(res.ingested).toBe(1);
    expect(res.dropped).toBe(1);
    // Ingested legs are marked backfilled (excluded from symmetry).
    expect(threadLog.read('t-4').entries.find((e) => e.messageId === 'm9')?.backfilled).toBe(true);
    expect(threadLog.read('t-4').entries.find((e) => e.messageId === 'mX')).toBeUndefined();
  });

  it('ignores peer-supplied chain fields — the requester assigns its own', () => {
    const requested = null; // anti-entropy: accept participant-authorized records
    ingestBackfill(deps(), 't-5', PEER, [
      { messageId: 'm1', body: 'x', createdAt: '2026-06-12T00:00:00.000Z', direction: 'inbound' },
    ], requested);
    const e = threadLog.read('t-5').entries[0];
    expect(e.seq).toBe(0); // OUR seq, not any peer-supplied value
    expect(e.author.agentFingerprint).toBe(PEER); // WE stamp the verified responder
  });
});

describe('runBackfillEpisode — terminating (SA2)', () => {
  it('a peer streaming new unreconcilable legs produces ONE Attention item + at most one round', async () => {
    await seed('t-6');
    const raised: string[] = [];
    // An initiator that NEVER reconciles (returns nothing) → terminal after one round.
    let rounds = 0;
    const d = deps({
      attention: { createAttentionItem: (i) => { raised.push(i.id); return i; } },
      backfillInitiator: async () => { rounds += 1; return []; },
    });
    // Peer reports a divergent (count, setAccum) that our log can't match.
    for (let i = 0; i < 4; i++) {
      await honorPeerThreadSync(d, 't-6', PEER, { digestVersion: DIGEST_VERSION, count: 99 + i, setAccum: 'd'.repeat(64) });
    }
    expect(store.get('t-6')?.symmetryState).toBe('diverged-unreconcilable');
    expect(rounds).toBe(1); // exactly ONE backfill round across all the divergent reports
    expect(new Set(raised).size).toBe(1); // ONE deduped Attention item for the thread
  });
});
