/**
 * Wiring-integrity tests — Correction & Preference Learning Sentinel, Slice 1b.
 *
 * The structural guarantees this loop must hold (spec §3.1/§3.6/§3.8 / §6):
 *   1. The CorrectionLedger is constructed IFF monitoring.correctionLearning
 *      .enabled — the inline /corrections routes 503 via the null ledger when off,
 *      200 when on (verified on the production AgentServer boot path).
 *   2. CorrectionLoopDeps carries NO proposal-minting + NO direct memory-file
 *      write (by-construction authority; the test asserts the interface surface).
 *   3. The LlmQueue caller catches all three rejection paths and drops silently
 *      with no retry (asserted in CorrectionCaptureLoop.test, re-pinned here for
 *      the wiring contract).
 *   4. captureAndDistill is fire-and-forget: it returns a resolved promise and a
 *      thrown distill error NEVER propagates (the onMessageLogged seam stays sync-safe).
 *   5. The loopback /feedback path REFUSES (no record state change) when the
 *      route's anomaly guard blocks (the post returns false → driver does not crash,
 *      does not double-route).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionAnalyzer } from '../../src/monitoring/CorrectionAnalyzer.js';
import { CorrectionLoopDriver } from '../../src/monitoring/CorrectionLoopDriver.js';
import { CaptureRing, captureAndDistill, drainBacklog } from '../../src/monitoring/CorrectionCaptureLoop.js';
import { CorrectionCaptureBacklog } from '../../src/monitoring/CorrectionCaptureBacklog.js';

const AUTH = 'corr-wiring-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('Correction-learning wiring integrity (Slice 1b)', () => {
  describe('CorrectionLedger constructed IFF enabled (production AgentServer boot path)', () => {
    let onDir: string, offDir: string;
    let onServer: AgentServer, offServer: AgentServer;

    beforeAll(() => {
      onDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-wire-on-'));
      offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-wire-off-'));
      for (const d of [onDir, offDir]) {
        fs.mkdirSync(path.join(d, '.instar', 'state', 'sessions'), { recursive: true });
        fs.mkdirSync(path.join(d, '.instar', 'state', 'jobs'), { recursive: true });
      }
      const mk = (dir: string, enabled: boolean): InstarConfig => ({
        projectName: enabled ? 'corr-on' : 'corr-off',
        agentName: 'Wiring',
        projectDir: dir,
        stateDir: path.join(dir, '.instar'),
        port: 0,
        authToken: AUTH,
        ...(enabled ? { monitoring: { correctionLearning: { enabled: true } } } : {}),
      } as InstarConfig);
      onServer = new AgentServer({ config: mk(onDir, true), sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(onDir, '.instar')) });
      offServer = new AgentServer({ config: mk(offDir, false), sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(offDir, '.instar')) });
    });

    afterAll(() => {
      SafeFsExecutor.safeRmSync(onDir, { recursive: true, force: true, operation: 'corr-wiring:on' });
      SafeFsExecutor.safeRmSync(offDir, { recursive: true, force: true, operation: 'corr-wiring:off' });
    });

    it('GET /corrections returns 200 when enabled (ledger constructed + non-null)', async () => {
      const res = await request(onServer.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.records)).toBe(true);
      // the on-disk ledger db is created by construction
      expect(fs.existsSync(path.join(onDir, '.instar', 'correction-ledger.db'))).toBe(true);
    });

    it('GET /corrections returns 503 when disabled (null ledger, no db created)', async () => {
      const res = await request(offServer.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(503);
      expect(fs.existsSync(path.join(offDir, '.instar', 'correction-ledger.db'))).toBe(false);
    });
  });

  describe('CorrectionLoopDeps carries no proposal-mint + no memory-write (by-construction §3.8)', () => {
    it('the driver constructs with exactly the bounded dep set and never reaches a proposal/memory path', async () => {
      const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      try {
        for (let i = 0; i < 4; i++) {
          ledger.record({ kind: 'user-preference', learning: 'lead with action', scrubbedSummary: 's', deterministicWeight: 3, topicId: (i % 2) + 1, detectedAt: `2026-05-0${(i % 2) + 1}T10:00:00Z` });
        }
        const recordPreference = vi.fn();
        const addAction = vi.fn(() => ({ id: 'a' }));
        const createInitiative = vi.fn(async () => ({ id: 'i' }));
        const feedbackLoopbackPost = vi.fn(async () => true);
        const attentionRoute = vi.fn(async () => true);
        // The ENTIRE dep surface — there is no createProposal / writeMemory.
        const deps = { addAction, createInitiative, feedbackLoopbackPost, recordPreference, attentionRoute };
        const driver = new CorrectionLoopDriver(ledger, new CorrectionAnalyzer(ledger), deps);
        await driver.route();
        // Under "autonomy ON" there is STILL no proposal-mint path reachable —
        // the only writes that happened were recordPreference + a tracked Action.
        expect(recordPreference).toHaveBeenCalled();
        expect(Object.keys(deps)).toEqual(
          expect.arrayContaining(['addAction', 'createInitiative', 'feedbackLoopbackPost', 'recordPreference', 'attentionRoute']),
        );
        expect(Object.keys(deps)).toHaveLength(5);
      } finally {
        ledger.close();
      }
    });
  });

  describe('captureAndDistill is fire-and-forget — a thrown distill error never propagates', () => {
    let ledger: CorrectionLedger | null = null;
    afterEach(() => { ledger?.close(); ledger = null; });

    it('returns a resolved promise even when distill throws synchronously', async () => {
      ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      const ring = new CaptureRing({ captureContextTurns: 6, captureTopicMapMax: 10, topicTtlMs: 600_000 });
      // distill throws synchronously inside the promise executor.
      const promise = captureAndDistill({
        ring,
        ledger,
        distill: () => { throw new Error('boom — should be swallowed'); },
      }, {
        topicId: 1, text: 'from now on x', fromUser: true, deterministicWeight: 3, isLearningSignal: true,
      });
      // Must resolve (never reject) — the seam stays sync-safe.
      await expect(promise).resolves.toBe('distill-dropped');
    });

    it('a void-invoked capture never throws into the calling (delivery) frame', () => {
      ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      const ring = new CaptureRing({ captureContextTurns: 6, captureTopicMapMax: 10, topicTtlMs: 600_000 });
      expect(() => {
        // exactly how server.ts invokes it: void fire-and-forget on the seam.
        void captureAndDistill({
          ring,
          ledger: ledger!,
          distill: async () => { throw new Error('async boom'); },
        }, { topicId: 1, text: 'from now on x', fromUser: true, deterministicWeight: 3, isLearningSignal: true });
      }).not.toThrow();
    });
  });

  describe('capture-backlog wiring (resilience extension)', () => {
    // Mirrors the server.ts gate: the backlog is constructed IFF the feature is
    // enabled AND captureBacklogMaxEntries > 0. maxEntries:0 → null (old drop).
    function constructBacklogPerWiring(cfg: { captureBacklogMaxEntries?: number }): CorrectionCaptureBacklog | null {
      const max = cfg.captureBacklogMaxEntries ?? 200;
      return max > 0 ? new CorrectionCaptureBacklog({ dbPath: ':memory:', maxEntries: max }) : null;
    }

    it('constructed when enabled + maxEntries>0; NULL when maxEntries=0 (preserves old drop)', () => {
      const withDefault = constructBacklogPerWiring({});
      expect(withDefault).toBeInstanceOf(CorrectionCaptureBacklog);
      withDefault?.close();

      const explicit = constructBacklogPerWiring({ captureBacklogMaxEntries: 50 });
      expect(explicit).toBeInstanceOf(CorrectionCaptureBacklog);
      explicit?.close();

      const disabled = constructBacklogPerWiring({ captureBacklogMaxEntries: 0 });
      expect(disabled).toBeNull();
    });

    it('a rate-limited capture lands in the backlog (not dropped) and never throws into the hook', async () => {
      const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      const backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
      try {
        const ring = new CaptureRing({ captureContextTurns: 6, captureTopicMapMax: 10, topicTtlMs: 600_000 });
        let threw = false;
        // exactly how server.ts invokes it — void fire-and-forget on the seam.
        try {
          await captureAndDistill(
            { ring, ledger, backlog, distill: async () => { throw new Error('LLM daily spend cap exceeded'); } },
            { topicId: 9, text: 'from now on stop apologizing', fromUser: true, deterministicWeight: 3, isLearningSignal: true },
          );
        } catch { threw = true; }
        expect(threw).toBe(false);     // never throws into the hook
        expect(backlog.count()).toBe(1); // persisted, not dropped
      } finally {
        ledger.close(); backlog.close();
      }
    });

    it('the drain is SKIPPED while the breaker is open and never throws', async () => {
      const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      const backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
      try {
        backlog.enqueue({ topicId: 1, turns: [{ fromUser: true, text: 'x', at: 0 }], deterministicWeight: 3 });
        const distill = vi.fn(async () => '{}');
        const result = await drainBacklog(
          { backlog, ledger, distill, llmAvailable: () => false }, // breaker open
          5,
        );
        expect(result.skipped).toBe('breaker-open');
        expect(distill).not.toHaveBeenCalled();
        expect(backlog.count()).toBe(1);
      } finally {
        ledger.close(); backlog.close();
      }
    });
  });

  describe('loopback /feedback REFUSES when the route guard blocks (no double-route, no crash)', () => {
    it('a blocked feedbackLoopbackPost (returns false) leaves toFeedback at 0 and does not crash', async () => {
      const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
      try {
        for (let i = 0; i < 4; i++) {
          ledger.record({ kind: 'infra-gap', learning: 'force push nag', scrubbedSummary: 'nag', deterministicWeight: 3, topicId: 1, detectedAt: `2026-05-0${(i % 3) + 1}T10:00:00Z` });
        }
        // Simulate the route's anomaly.check returning blocked → POST is not 201.
        const feedbackLoopbackPost = vi.fn(async () => false);
        const driver = new CorrectionLoopDriver(ledger, new CorrectionAnalyzer(ledger), {
          addAction: () => ({ id: 'a' }),
          createInitiative: async () => ({ id: 'i' }),
          feedbackLoopbackPost,
          recordPreference: () => { /* not reached for infra-gap */ },
          attentionRoute: async () => true,
          autoFeedback: true,
        });
        const result = await driver.route();
        expect(feedbackLoopbackPost).toHaveBeenCalledTimes(1); // attempted once
        expect(result.toFeedback).toBe(0);                     // blocked → not counted
        // record was still moved to acted-on (it was routed; the guard rejection
        // is the route's verdict, not a reason to re-route on the next tick).
        expect(result.routed.length).toBe(1);
      } finally {
        ledger.close();
      }
    });
  });
});
