/**
 * Tier 3 (E2E "feature is alive") — Threadline Canonical History (Robustness
 * Phase 2, CMT-1362).
 *
 * Mirrors the PRODUCTION init path (src/commands/server.ts ~L10101): the canonical
 * ThreadLog + ThreadMessageRecorder are constructed from the REAL ConfigDefaults,
 * the retention seam is wired, and the routes are mounted. Proves end-to-end:
 *   1. FEATURE IS ALIVE — GET /threadline/threads/:id returns 200 (not 503), wired.
 *   2. F3 incident reproduced + fixed — a sender reads back its OWN ≥4 messages.
 *   3. F5 incident reproduced + fixed — the resolver keeps a (peer, workstream) on
 *      ONE canonical thread across a simulated restart; an explicit fork makes two.
 *   4. Symmetry across the send→receive boundary — two instances converge to equal
 *      (count, setAccum) from the IDENTITY-FREE projection (not a same-process hash).
 *   5. diverged → bounded backfill → STICKY terminal diverged-unreconcilable, one
 *      Attention item, no loop.
 *   6. Dev-gating — the resolver JOIN is LIVE on a dev agent, DARK on the fleet.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { ThreadLog } from '../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { ThreadMessageRecorder } from '../../src/threadline/recordThreadMessage.js';
import { honorPeerThreadSync, localThreadSync } from '../../src/threadline/threadSymmetry.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DIGEST_VERSION } from '../../src/threadline/threadDigest.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'e2e-token';
let dir: string;

/** Mirror the production server.ts wiring of the canonical-history stack. */
function buildStack(opts: { developmentAgent?: boolean } = {}) {
  // Resolve the FULL config (defaults applied) the way the server does.
  const merged: any = { developmentAgent: opts.developmentAgent ?? false };
  applyDefaults(merged, getMigrationDefaults('managed-project'));
  const canon = merged.threadline?.canonicalHistory ?? {};
  const threadLog = new ThreadLog(dir, {
    maxEntriesPerThread: canon.maxEntriesPerThread,
    seenSetMaxPerThread: canon.seenSetMaxPerThread,
    seenSetMaxThreads: canon.seenSetMaxThreads,
  });
  const store = new ConversationStore(dir);
  const recorder = new ThreadMessageRecorder({ threadLog, conversationStore: store, logDir: path.join(dir, 'logs'), headCacheCoalesceMs: 1 });
  store.setLogRetentionSeam((tid) => threadLog.deleteThread(tid));
  const ctx: any = {
    config: { authToken: AUTH, stateDir: dir, port: 0, projectName: 'echo', developmentAgent: opts.developmentAgent, threadline: merged.threadline },
    stateDir: dir, threadLog, threadMessageRecorder: recorder, conversationStore: store,
    messageRouter: null, listenerManager: null, telegram: null, coordinator: null, getInboundQueue: () => null,
  };
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return { app, threadLog, store, recorder, config: merged };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canon-e2e-')); });
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/threadline-canonical-history-lifecycle.test.ts' }); } catch { /* ignore */ } });

describe('Threadline Canonical History — feature is alive', () => {
  it('production init wires the funnel + GET /threadline/threads/:id returns 200 (not 503)', async () => {
    const { app, recorder } = buildStack({ developmentAgent: true });
    recorder.record({ threadId: 'thread-alive', messageId: 'm1', direction: 'outbound', body: 'hi', createdAt: '2026-06-12T00:00:00.000Z' });
    const res = await request(app).get('/threadline/threads/thread-alive').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.messageCount).toBe(1);
    const health = await request(app).get('/threadline/threads/thread-alive/health').set('Authorization', `Bearer ${AUTH}`);
    expect(health.status).toBe(200);
  });
});

describe('F3 incident reproduced + fixed', () => {
  it('a sender reads back its own ≥4 messages on the very thread that returned 0 before', async () => {
    const { app, recorder } = buildStack();
    const THREAD = 'msg-1781236493501-ingw5t'; // the literal incident thread
    for (let i = 1; i <= 4; i++) {
      recorder.record({ threadId: THREAD, messageId: `out-${i}`, direction: 'outbound', body: `leg ${i}`, createdAt: `2026-06-12T00:00:0${i}.000Z`, peerFingerprint: 'fp-dawn' });
    }
    const res = await request(app).get(`/threadline/threads/${THREAD}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.entries.filter((e: any) => e.direction === 'outbound').length).toBe(4); // NOT 0
  });
});

describe('F5 incident reproduced + fixed (resolver)', () => {
  it('a (peer, workstream) stays ONE canonical thread across a restart; an explicit fork makes a second', async () => {
    const { recorder, store } = buildStack({ developmentAgent: true });
    const PEER = 'fp-dawn-stable';
    // ENFORCE the resolver (a dev agent flips dryRun off): replies JOIN the canonical.
    const opts = { peerPrincipal: PEER, subject: 'feedback cutover', enabled: true, dryRun: false, workstreamKeyMode: 'subject-slug' as const, isHolder: true };
    const first = await recorder.resolveOutboundThread({ ...opts, mintedThreadId: 'uuid-1' });
    expect(first.decision).toBe('minted:no-binding');
    const join = await recorder.resolveOutboundThread({ ...opts, mintedThreadId: 'uuid-2' });
    expect(join).toMatchObject({ threadId: 'uuid-1', decision: 'joined:existing-binding' });

    // Simulate a restart: the durable binding survives on conversations.json (the
    // ephemeral affinity that the OLD code relied on would have been lost here).
    const store2 = new ConversationStore(dir);
    const recorder2 = new ThreadMessageRecorder({ threadLog: new ThreadLog(dir), conversationStore: store2, headCacheCoalesceMs: 1 });
    const afterRestart = await recorder2.resolveOutboundThread({ ...opts, mintedThreadId: 'uuid-3' });
    expect(afterRestart).toMatchObject({ threadId: 'uuid-1', decision: 'joined:existing-binding' });

    // An explicit fork DOES create a second thread (and never steals the canonical).
    const forked = await recorder2.resolveOutboundThread({ ...opts, mintedThreadId: 'uuid-fork', fork: true });
    expect(forked).toMatchObject({ threadId: 'uuid-fork', decision: 'minted:fork-requested' });
    expect(store2.resolveCanonicalThread(PEER, 'feedback-cutover')).toEqual({ kind: 'found', threadId: 'uuid-1' });
  });
});

describe('Symmetry across the send→receive boundary', () => {
  it('two independent instances converge to EQUAL (count, setAccum) from the identity-free projection', () => {
    // Two "agents" on separate stores/logs, each logging the SAME conversation from
    // its own side (outbound↔inbound mirror), with byte-identical {id, body, createdAt}.
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-A-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-B-'));
    try {
      const logA = new ThreadLog(dirA); const storeA = new ConversationStore(dirA);
      const logB = new ThreadLog(dirB); const storeB = new ConversationStore(dirB);
      const recA = new ThreadMessageRecorder({ threadLog: logA, conversationStore: storeA, headCacheCoalesceMs: 1 });
      const recB = new ThreadMessageRecorder({ threadLog: logB, conversationStore: storeB, headCacheCoalesceMs: 1 });
      const T = 'thread-sym';
      const msgs = [
        { id: 'm1', body: 'A→B one', createdAt: '2026-06-12T00:00:01.000Z', from: 'A' },
        { id: 'm2', body: 'B→A two', createdAt: '2026-06-12T00:00:02.000Z', from: 'B' },
        { id: 'm3', body: 'A→B three', createdAt: '2026-06-12T00:00:03.000Z', from: 'A' },
      ];
      // A logs its outbound + the inbound it receives; B mirrors (different LOCAL order).
      for (const m of msgs) recA.record({ threadId: T, messageId: m.id, direction: m.from === 'A' ? 'outbound' : 'inbound', body: m.body, createdAt: m.createdAt, peerFingerprint: 'fpB' });
      for (const m of [...msgs].reverse()) recB.record({ threadId: T, messageId: m.id, direction: m.from === 'B' ? 'outbound' : 'inbound', body: m.body, createdAt: m.createdAt, peerFingerprint: 'fpA' });
      const a = localThreadSync(logA, T);
      const b = localThreadSync(logB, T);
      expect(a.count).toBe(b.count);
      expect(a.setAccum).toBe(b.setAccum); // identity-free + order-independent → EQUAL cross-instance
      expect(a.digestVersion).toBe(DIGEST_VERSION);
    } finally {
      SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/e2e/threadline-canonical-history-lifecycle.test.ts' });
      SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/e2e/threadline-canonical-history-lifecycle.test.ts' });
    }
  });

  it('an injected missing leg → diverged → bounded backfill → STICKY terminal, ONE Attention item, no loop', async () => {
    const { threadLog, store, recorder } = buildStack({ developmentAgent: true });
    const T = 'thread-diverge'; const PEER = 'fp-dawn';
    recorder.record({ threadId: T, messageId: 'm1', direction: 'inbound', body: 'a', createdAt: '2026-06-12T00:00:00.000Z', peerFingerprint: PEER });
    await store.mutate(T, (d) => { d.participants.peers = [PEER]; return d; });

    const raised: string[] = [];
    let rounds = 0;
    const deps = {
      threadLog, conversationStore: store, threadMessageRecorder: recorder,
      attention: { createAttentionItem: (i: any) => { raised.push(i.id); return i; } },
      // The peer holds a leg we never received → the backfill can't reconcile it.
      backfillInitiator: async () => { rounds += 1; return []; },
    };
    // Peer reports a divergent head across SEVERAL messages — must mint ONE episode.
    for (let i = 0; i < 5; i++) {
      await honorPeerThreadSync(deps, T, PEER, { digestVersion: DIGEST_VERSION, count: 50 + i, setAccum: 'f'.repeat(64) });
    }
    expect(store.get(T)?.symmetryState).toBe('diverged-unreconcilable'); // STICKY terminal
    expect(rounds).toBe(1);                 // exactly ONE bounded backfill round
    expect(new Set(raised).size).toBe(1);   // ONE deduped Attention item, no loop
  });
});

describe('Dev-gating (the Phase-1 miss, now enforced)', () => {
  it('the resolver JOIN is LIVE on a dev agent and DARK on the fleet (resolveDevAgentGate)', () => {
    const devCfg: any = { developmentAgent: true };
    applyDefaults(devCfg, getMigrationDefaults('managed-project'));
    const fleetCfg: any = { developmentAgent: false };
    applyDefaults(fleetCfg, getMigrationDefaults('managed-project'));
    const path0 = (c: any) => c.threadline?.canonicalHistory?.conversationDiscipline?.enabled;
    // The default OMITS `enabled` so the gate decides at runtime.
    expect(path0(devCfg)).toBeUndefined();
    expect(resolveDevAgentGate(path0(devCfg), devCfg)).toBe(true);   // LIVE on dev
    expect(resolveDevAgentGate(path0(fleetCfg), fleetCfg)).toBe(false); // DARK on fleet
    // And dryRun ships true (live-on-dev only emits telemetry, no reroute).
    expect(devCfg.threadline.canonicalHistory.conversationDiscipline.dryRun).toBe(true);
  });
});
