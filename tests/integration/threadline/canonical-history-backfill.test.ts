/**
 * Integration (Tier 2) — the UNION read source + one-time bounded backfill (D-C):
 * an empty canonical log whose outbox/aggregate hold legs returns those legs
 * (marked backfilled), backfill is memoized (no re-scan), a RESTORE (memo set +
 * log absent) RE-runs backfill (SI2), and a legacy peer (no contentDigest) is
 * recorded with a locally-computed digest. Plus the participant-authorized backfill
 * responder + untrusted ingest over the real symmetry helpers (SA1/SA4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../../src/server/routes.js';
import { ThreadLog } from '../../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { ThreadMessageRecorder } from '../../../src/threadline/recordThreadMessage.js';
import { serveBackfill, ingestBackfill } from '../../../src/threadline/threadSymmetry.js';
import { contentDigest } from '../../../src/threadline/threadDigest.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const AUTH = 'tkn';
let dir: string;
let app: express.Express;
let threadLog: ThreadLog;
let store: ConversationStore;
let recorder: ThreadMessageRecorder;

function writeOutbox(entries: Array<{ id: string; timestamp: string; threadId: string; text: string }>) {
  const p = path.join(dir, 'threadline', 'outbox.jsonl.active');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-backfill-'));
  threadLog = new ThreadLog(dir);
  store = new ConversationStore(dir);
  recorder = new ThreadMessageRecorder({ threadLog, conversationStore: store, headCacheCoalesceMs: 1 });
  // A messageRouter stub whose getThread returns the inbound aggregate (O(thread)).
  const messageRouter: any = {
    getThread: async (tid: string) => ({
      thread: { id: tid },
      messages: tid === 'thread-bf'
        ? [{ message: { id: 'in-old-1', body: 'peer said hi', createdAt: '2026-06-11T10:00:00.000Z', from: { agent: 'dawn' } } }]
        : [],
    }),
  };
  const ctx: any = {
    config: { authToken: AUTH, stateDir: dir, port: 0, projectName: 'echo' },
    stateDir: dir, threadLog, threadMessageRecorder: recorder, conversationStore: store,
    messageRouter, listenerManager: null, telegram: null, coordinator: null, getInboundQueue: () => null,
  };
  app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/canonical-history-backfill.test.ts' }); } catch { /* ignore */ } });

describe('UNION read + one-time memoized backfill (D-C / guard-bypass-carries-its-own-cap)', () => {
  it('an empty canonical log returns outbox + aggregate legs marked backfilled', async () => {
    writeOutbox([{ id: 'out-old-1', timestamp: '2026-06-11T09:00:00.000Z', threadId: 'thread-bf', text: 'I proposed X' }]);
    const res = await request(app).get('/threadline/threads/thread-bf').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    // The sender's own outbound leg + the peer's inbound leg, both reconstructed.
    const ids = res.body.entries.map((e: any) => e.messageId).sort();
    expect(ids).toEqual(['in-old-1', 'out-old-1']);
    expect(res.body.entries.every((e: any) => e.backfilled === true)).toBe(true);
  });

  it('backfill is memoized — a second read does not re-scan (no duplicate legs)', async () => {
    writeOutbox([{ id: 'out-old-1', timestamp: '2026-06-11T09:00:00.000Z', threadId: 'thread-bf', text: 'I proposed X' }]);
    await request(app).get('/threadline/threads/thread-bf').set('Authorization', `Bearer ${AUTH}`);
    const res2 = await request(app).get('/threadline/threads/thread-bf').set('Authorization', `Bearer ${AUTH}`);
    expect(res2.body.entries.length).toBe(2); // not 4 — the funnel is idempotent + memoized
    expect(store.get('thread-bf')?.backfilled).toBe(true);
  });

  it('RESTORE (memo set + log file ABSENT) RE-runs backfill — not a permanently empty thread (SI2)', async () => {
    writeOutbox([{ id: 'out-old-1', timestamp: '2026-06-11T09:00:00.000Z', threadId: 'thread-bf', text: 'I proposed X' }]);
    await request(app).get('/threadline/threads/thread-bf').set('Authorization', `Bearer ${AUTH}`);
    // Simulate restore-from-backup: conversations.json (the memo) survives, the log
    // does not. A real restore is a PROCESS RESTART → a COLD ThreadLog cache, so
    // rebuild the stack fresh against the same dir (the warm seen-set would
    // otherwise mask the absent file).
    SafeFsExecutor.safeRmSync(path.join(dir, 'threadline', 'threads', 'thread-bf.log.jsonl'), { force: true, operation: 'tests/integration/threadline/canonical-history-backfill.test.ts:restore' });
    SafeFsExecutor.safeRmSync(path.join(dir, 'threadline', 'threads', 'thread-bf.meta.json'), { force: true, operation: 'tests/integration/threadline/canonical-history-backfill.test.ts:restore' });
    expect(store.get('thread-bf')?.backfilled).toBe(true); // memo survived the restore

    const freshLog = new ThreadLog(dir);
    const freshStore = new ConversationStore(dir);
    const freshRecorder = new ThreadMessageRecorder({ threadLog: freshLog, conversationStore: freshStore, headCacheCoalesceMs: 1 });
    const freshCtx: any = {
      config: { authToken: AUTH, stateDir: dir, port: 0, projectName: 'echo' },
      stateDir: dir, threadLog: freshLog, threadMessageRecorder: freshRecorder, conversationStore: freshStore,
      messageRouter: { getThread: async () => ({ thread: { id: 'thread-bf' }, messages: [{ message: { id: 'in-old-1', body: 'peer said hi', createdAt: '2026-06-11T10:00:00.000Z', from: { agent: 'dawn' } } }] }) },
      listenerManager: null, telegram: null, coordinator: null, getInboundQueue: () => null,
    };
    const freshApp = express();
    freshApp.use(express.json());
    freshApp.use(createRoutes(freshCtx));
    const res = await request(freshApp).get('/threadline/threads/thread-bf').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.messageCount).toBe(2); // backfill re-ran despite the memo (SI2)
  });
});

describe('participant-authorized backfill responder + untrusted ingest (SA1/SA4)', () => {
  const PEER = 'fp-dawn-1';
  beforeEach(async () => {
    recorder.record({ threadId: 'thread-x', messageId: 'm1', direction: 'inbound', body: 'a', createdAt: '2026-06-12T00:00:00.000Z', peerFingerprint: PEER });
    await store.mutate('thread-x', (d) => { d.participants.peers = [PEER]; return d; });
  });
  const deps = () => ({ threadLog, conversationStore: store, threadMessageRecorder: recorder });

  it('a verified-but-NON-participant peer naming the thread gets EMPTY (cross-thread exfiltration blocked)', () => {
    const cd = contentDigest({ threadId: 'thread-x', messageId: 'm1', body: 'a', createdAt: '2026-06-12T00:00:00.000Z' });
    expect(serveBackfill(deps(), 'thread-x', PEER, [cd]).length).toBe(1);   // participant → served
    expect(serveBackfill(deps(), 'thread-x', 'fp-attacker', [cd])).toEqual([]); // non-participant → empty
  });

  it('ingest IGNORES forged peer chain fields + drops an unrequested record', () => {
    const wanted = contentDigest({ threadId: 'thread-y', messageId: 'good', body: 'wanted', createdAt: '2026-06-12T00:00:00.000Z' });
    const res = ingestBackfill(deps(), 'thread-y', PEER, [
      { messageId: 'good', body: 'wanted', createdAt: '2026-06-12T00:00:00.000Z', direction: 'inbound' },
      { messageId: 'evil', body: 'unrequested', createdAt: '2026-06-12T00:00:00.000Z', direction: 'inbound' },
    ], new Set([wanted]));
    expect(res).toEqual({ ingested: 1, dropped: 1 });
    const good = threadLog.read('thread-y').entries.find((e) => e.messageId === 'good');
    expect(good?.seq).toBe(0); // OUR seq, not a forged one
    expect(good?.backfilled).toBe(true);
  });
});

describe('legacy-peer downgrade (no flag-day)', () => {
  it('a message with no contentDigest is recorded with a locally-computed digest, symmetry unverified-peer-legacy', async () => {
    // No wireDigest supplied (legacy peer) — the funnel computes the digest locally.
    recorder.record({ threadId: 'thread-legacy', messageId: 'm1', direction: 'inbound', body: 'hi', createdAt: '2026-06-12T00:00:00.000Z', peerFingerprint: 'fp-legacy' });
    const res = await request(app).get('/threadline/threads/thread-legacy/health').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.chainOk).toBe(true);
    expect(['unverified-peer-legacy', 'unknown']).toContain(res.body.symmetryState);
  });
});
