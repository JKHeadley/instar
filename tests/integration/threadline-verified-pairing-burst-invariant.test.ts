/**
 * BURST INVARIANT — Secure A2A Verified Pairing verification-failed re-attempt loop
 * (spec §3.2 / §3.7 / §6).
 *
 * A `verification-failed` (operator-asserted SAS mismatch) is a potential-MITM signal
 * and MUST raise ONE HIGH attention item per (peerFp) episode — NEVER one-per-attempt.
 * The 2026-05-22 / 2026-06-05 topic-flood incidents proved that a housekeeping/security
 * feature emitting per-event WILL flood the user with forum topics unless the emission
 * is shaped at the chokepoint. This test pins the two structural guarantees that make a
 * re-attempt LOOP (re-handshake → mismatch → re-handshake → mismatch …) collapse onto
 * ONE topic at the SHIPPED defaults:
 *
 *   (a) The emission uses a STABLE per-peerFp id
 *       (`threadline-pairing-verification-failed:<peerFp>`), so createAttentionItem
 *       UPSERTS the same item — a repeat returns the existing item, no new topic.
 *   (b) Even were the id to vary, HIGH priority is the right class for a security
 *       alert: HIGH is the never-coalesced class, but a wall of HIGH still cannot
 *       outrun the createForumTopic global ceiling.
 *
 * Mirrors tests/integration/notification-flood-burst-invariant.test.ts (production-
 * default budgets, real TelegramAdapter, apiCall stubbed) and adds an end-to-end check
 * through the REAL verify route to prove the route emits with the stable id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { generateIdentityKeyPair, deriveSAS, deriveSasBits, deriveSasFingerprint } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';

interface Recorder { forumTopicsCreated: number; topicTitles: string[]; }
function installApiStub(adapter: TelegramAdapter): Recorder {
  const rec: Recorder = { forumTopicsCreated: 0, topicTitles: [] };
  let threadSeq = 6000;
  vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'createForumTopic') {
        rec.forumTopicsCreated++;
        rec.topicTitles.push(String(params.name ?? ''));
        return { message_thread_id: ++threadSeq, name: params.name };
      }
      if (method === 'sendMessage') return { message_id: threadSeq * 10 };
      return { ok: true };
    });
  return rec;
}

const PEER_FP = 'abcabcabcabcabcabcabcabcabcabcab';

describe('Verified Pairing — verification-failed burst invariant (production-default budgets)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-burst-'));
    // No guard config — pin the SHIPPED defaults.
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 }, tmpDir);
  });
  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'vp-burst cleanup' });
  });

  it('a 200-attempt verification-failed LOOP from ONE peer creates exactly ONE topic (stable per-peerFp id)', async () => {
    const rec = installApiStub(adapter);
    const id = `threadline-pairing-verification-failed:${PEER_FP}`;
    for (let i = 0; i < 200; i++) {
      await adapter.createAttentionItem({
        id, // STABLE per-peerFp id — exactly what the verify route emits
        title: 'Threadline pairing verification FAILED — possible MITM',
        summary: `attempt ${i}`,
        category: 'general',
        priority: 'HIGH',
        sourceContext: 'threadline-verified-pairing',
      });
    }
    // The upsert collapses the whole loop onto ONE item → ONE topic.
    expect(rec.forumTopicsCreated).toBe(1);
    // And exactly one attention item exists for this peer.
    expect(adapter.getAttentionItems().filter((a) => a.id === id).length).toBe(1);
  });

  it('HIGH verification-failed items are NEVER coalesced — each distinct peer gets its own topic (security alerts stay individually visible)', async () => {
    const rec = installApiStub(adapter);
    // DISTINCT peers (distinct ids), a count within the per-source/global budget so we
    // observe the no-coalesce property cleanly: a security alert must always be
    // individually visible — HIGH is the never-coalesced class.
    const N = 5;
    for (let i = 0; i < N; i++) {
      await adapter.createAttentionItem({
        id: `threadline-pairing-verification-failed:peer-${i}`,
        title: 'Threadline pairing verification FAILED — possible MITM',
        summary: `peer ${i}`,
        category: 'general',
        priority: 'HIGH',
        sourceContext: 'threadline-verified-pairing',
      });
    }
    // No coalesced notice topic for HIGH (HIGH always passes the guard) — each peer's
    // alert is its own topic, never merged into a shared "notices coalesced" topic.
    expect(rec.topicTitles.filter((t) => t.toLowerCase().includes('coalesced')).length).toBe(0);
    expect(rec.forumTopicsCreated).toBe(N);
  });
});

describe('Verified Pairing — the verify route emits ONE deduped item on a re-attempt loop', () => {
  let tmpDirs: string[] = [];
  function mkStateDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-burst-route-'));
    fs.mkdirSync(path.join(d, 'threadline'), { recursive: true });
    tmpDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    tmpDirs = [];
  });

  it('repeated PIN-authed match:false (re-handshake then mismatch) raises ONE item via the stable id', async () => {
    const stateDir = mkStateDir();
    const tm = new AgentTrustManager({ stateDir });
    const selfKp = generateIdentityKeyPair();
    const peerKp = generateIdentityKeyPair();
    const selfFp = computeFingerprint(selfKp.publicKey);
    const peerFp = computeFingerprint(peerKp.publicKey);

    // A spy attention surface — counts how many DISTINCT ids are raised.
    const raisedIds: string[] = [];
    const telegram = {
      createAttentionItem: (item: { id: string }) => {
        // Mimic the upsert-dedup contract of the real adapter.
        if (!raisedIds.includes(item.id)) raisedIds.push(item.id);
        return Promise.resolve(item);
      },
    };

    const ctx = {
      config: {
        projectName: 'test', projectDir: stateDir, stateDir, port: 0,
        sessions: {} as never, scheduler: {} as never,
        threadline: { verifiedPairing: { enabled: true } },
        dashboardPin: '101010',
      },
      sessionManager: {} as never,
      state: {} as never,
      unifiedTrust: { trustManager: tm },
      telegram,
      threadlineReplyWaiters: new Map(),
      startTime: new Date(),
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));

    // The re-attempt loop: re-handshake (records a fresh pending pairing) → operator
    // asserts mismatch (match:false) → repeat. Each iteration is a genuine new epoch.
    for (let i = 0; i < 5; i++) {
      const sharedSecret = crypto.randomBytes(32);
      const sasWords = deriveSAS(sharedSecret, selfKp.publicKey, peerKp.publicKey);
      const sasFingerprint = deriveSasFingerprint(deriveSasBits(sharedSecret, selfKp.publicKey, peerKp.publicKey));
      tm.recordPendingVerification(peerFp, {
        pairingId: crypto.randomBytes(16).toString('hex'),
        peerIdentityPub: peerKp.publicKey.toString('hex'),
        sasWords, sasFingerprint, ownFp: selfFp,
      });
      const res = await request(app)
        .post(`/threadline/pairing/${peerFp}/verify`)
        .send({ match: false, pin: '101010' });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('verification-failed');
    }

    // ONE id raised across the whole loop — never one-per-attempt.
    expect(raisedIds).toEqual([`threadline-pairing-verification-failed:${peerFp}`]);
  });
});
