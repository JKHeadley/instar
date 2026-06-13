/**
 * Integration (Tier 2) — the canonical-history READ surfaces over the REAL router:
 * the F3 regression (a sender reads back its own messages), the seq-paginated
 * canonical read, the symmetry health route, the bearer gate, and the traversal
 * allowlist. Uses a REAL ThreadLog + ThreadMessageRecorder + ConversationStore.
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
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const AUTH = 'test-bearer-token';
let dir: string;
let app: express.Express;
let threadLog: ThreadLog;
let store: ConversationStore;
let recorder: ThreadMessageRecorder;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-routes-'));
  threadLog = new ThreadLog(dir);
  store = new ConversationStore(dir);
  recorder = new ThreadMessageRecorder({ threadLog, conversationStore: store, headCacheCoalesceMs: 1 });
  const ctx: any = {
    config: { authToken: AUTH, stateDir: dir, port: 0, projectName: 'echo' },
    stateDir: dir,
    threadLog,
    threadMessageRecorder: recorder,
    conversationStore: store,
    messageRouter: null,
    listenerManager: null,
    telegram: null,
    coordinator: null,
    getInboundQueue: () => null,
  };
  app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/canonical-history-routes.test.ts' }); } catch { /* ignore */ } });

/** Simulate the funnel logging the sender's own ≥4 outbound legs + a reply. */
function seedIncident(threadId: string) {
  for (let i = 1; i <= 4; i++) {
    recorder.record({ threadId, messageId: `msg-out-${i}`, direction: 'outbound', body: `proposal ${i}`, createdAt: `2026-06-12T00:00:0${i}.000Z`, peerFingerprint: 'fp-dawn-1' });
  }
  recorder.record({ threadId, messageId: 'msg-in-1', direction: 'inbound', body: 'ack', createdAt: '2026-06-12T00:00:09.000Z', peerFingerprint: 'fp-dawn-1' });
}

describe('GET /threadline/threads/:id — canonical read (D-C)', () => {
  it('F3: the sender reads back its OWN ≥4 messages on the thread (not 0)', async () => {
    seedIncident('msg-1781236493501-ingw5t');
    const res = await request(app)
      .get('/threadline/threads/msg-1781236493501-ingw5t')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.messageCount).toBe(5);
    const outbound = res.body.entries.filter((e: any) => e.direction === 'outbound');
    expect(outbound.length).toBe(4); // the literal incident: 4 of the sender's own sent messages
    expect(res.body.bodiesAreUntrustedData).toBe(true);
  });

  it('accepts the real minted id shapes (msg-/thread-/uuid) the old UUID-only regex rejected', async () => {
    seedIncident('thread-840d5c1d');
    const res = await request(app).get('/threadline/threads/thread-840d5c1d').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.messageCount).toBe(5);
  });

  it('is seq-cursor paginated', async () => {
    seedIncident('thread-page');
    const page1 = await request(app).get('/threadline/threads/thread-page?limit=2').set('Authorization', `Bearer ${AUTH}`);
    expect(page1.body.entries.length).toBe(2);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await request(app).get(`/threadline/threads/thread-page?limit=10&afterSeq=${page1.body.nextCursor}`).set('Authorization', `Bearer ${AUTH}`);
    expect(page2.body.entries[0].seq).toBeGreaterThan(page1.body.nextCursor);
  });

  it('is bearer-gated (401 without the owner token)', async () => {
    seedIncident('thread-auth');
    const res = await request(app).get('/threadline/threads/thread-auth');
    expect(res.status).toBe(401);
  });

  it('rejects traversal ids and never escapes the threads dir (FD-7)', async () => {
    for (const bad of ['..%2f..%2fetc%2fpasswd', 'thread-..', 'thread-x%00']) {
      const res = await request(app).get(`/threadline/threads/${bad}`).set('Authorization', `Bearer ${AUTH}`);
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe('GET /threadline/threads/:id/health — advisory symmetry (D-D)', () => {
  it('reports verified when a peer threadSync matches, unknown with no peer report', async () => {
    seedIncident('thread-health');
    // No peer report yet → unverified-peer-legacy or unknown.
    const noPeer = await request(app).get('/threadline/threads/thread-health/health').set('Authorization', `Bearer ${AUTH}`);
    expect(noPeer.status).toBe(200);
    expect(['unknown', 'unverified-peer-legacy']).toContain(noPeer.body.symmetryState);
    expect(noPeer.body.chainOk).toBe(true);

    // Stamp a matching peer threadSync → verified.
    const head = threadLog.head('thread-health');
    await store.mutate('thread-health', (d) => { d.participants.peers = ['fp-dawn-1']; return d; });
    await store.stampSymmetry('thread-health', 'verified', { digestVersion: 1, count: head.count, setAccum: head.setAccum, at: new Date().toISOString() });
    const verified = await request(app).get('/threadline/threads/thread-health/health').set('Authorization', `Bearer ${AUTH}`);
    expect(verified.body.symmetryState).toBe('verified');
    expect(verified.body.local.count).toBe(head.count);
  });

  it('surfaces local-integrity-fault + a recovery playbook on a torn chain', async () => {
    seedIncident('thread-torn');
    // Corrupt a line in the live log → verify() fails.
    const p = path.join(dir, 'threadline', 'threads', 'thread-torn.log.jsonl');
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
    const parsed = JSON.parse(lines[1]); parsed.contentDigest = 'tampered';
    lines[1] = JSON.stringify(parsed);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    const res = await request(app).get('/threadline/threads/thread-torn/health').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.symmetryState).toBe('local-integrity-fault');
    expect(res.body.recovery).toMatch(/re-converge from the peer/);
  });
});

describe('GET /messages/thread/:threadId — re-pointed at the canonical log (D-C)', () => {
  it('returns the canonical log entries (source: canonical-log), including the sender\'s own legs', async () => {
    seedIncident('thread-mcp');
    const res = await request(app).get('/messages/thread/thread-mcp').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.thread.source).toBe('canonical-log');
    expect(res.body.thread.messageCount).toBe(5);
    expect(res.body.messages.length).toBe(5);
  });
});
