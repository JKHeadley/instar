/**
 * E2E — Correction capture-backlog with retry (resilience extension) full
 * round-trip. Tier 3 of the Testing Integrity Standard.
 *
 *   Phase 1 — Feature is alive: the /corrections read surface returns 200 on the
 *             production AgentServer boot path when the feature is enabled. The
 *             backlog's job is to FEED that ledger under throttle; this is the
 *             surface a drained capture becomes observable on.
 *   Phase 2 — Full round-trip: a learning-signal capture is RATE-LIMITED at
 *             distill time → lands in the durable backlog (not dropped). Then,
 *             when the LLM becomes available, drainBacklog distills it into the
 *             CorrectionLedger and DELETES the backlog row. The distilled record
 *             is then observable on GET /corrections — proving the data survived
 *             the throttle and reached the ledger.
 *   Phase 3 — The drain is breaker-gated: while the breaker is open the backlog
 *             is NOT drained (the entry waits); it only drains once available.
 *
 * Uses the SAME classes server.ts wires (captureAndDistill / CorrectionCaptureBacklog
 * / drainBacklog / CorrectionLedger), proving the data path is real end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { CorrectionCaptureBacklog } from '../../src/monitoring/CorrectionCaptureBacklog.js';
import { CaptureRing, captureAndDistill, drainBacklog } from '../../src/monitoring/CorrectionCaptureLoop.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'corr-backlog-e2e-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('Correction capture-backlog with retry — E2E lifecycle', () => {
  describe('Phase 1: feature is alive (the read surface the drain feeds)', () => {
    let dir: string, server: AgentServer;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-e2e-alive-'));
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
      const config: InstarConfig = {
        projectName: 'ccb-e2e-alive', agentName: 'E2E', projectDir: dir,
        stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
        monitoring: { correctionLearning: { enabled: true } },
      } as InstarConfig;
      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(dir, '.instar')) });
    });
    afterAll(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'ccb-e2e:p1' }); });

    it('GET /corrections returns 200 when enabled', async () => {
      const res = await request(server.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(200);
    });
  });

  describe('Phase 2 + 3: throttle → backlog → drain → ledger (observable on /corrections)', () => {
    let dir: string, server: AgentServer, ledgerDbPath: string;
    let ledger: CorrectionLedger | null = null;
    let backlog: CorrectionCaptureBacklog | null = null;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-e2e-rt-'));
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
      ledgerDbPath = path.join(dir, '.instar', 'correction-ledger.db');
    });
    afterAll(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'ccb-e2e:p2' }); });
    afterEach(() => { ledger?.close(); backlog?.close(); ledger = null; backlog = null; });

    it('a rate-limited capture survives the throttle and is distilled into the ledger when the LLM recovers', async () => {
      // The SAME on-disk ledger the server reads from + a sibling backlog db.
      ledger = new CorrectionLedger({ dbPath: ledgerDbPath, machineId: 'e2e' });
      backlog = new CorrectionCaptureBacklog({ dbPath: path.join(dir, '.instar', 'correction-capture-backlog.db') });
      const ring = new CaptureRing({ captureContextTurns: 6, captureTopicMapMax: 10, topicTtlMs: 600_000 });

      // ── Throttle window: distill is rate-limited → capture goes to the backlog.
      let breakerOpen = true;
      const distill = async (prompt: string) => {
        if (breakerOpen) throw new Error('LLM daily spend cap exceeded');
        // Headroom: a realistic distill envelope for the recurring preference.
        void prompt;
        return JSON.stringify({
          learning: 'stop apologizing repeatedly; just make the correction',
          kind: 'user-preference',
          llm_confidence: 0.92,
          scrubbed_summary: 'Prefers a single brief correction over repeated apologies.',
        });
      };

      const decision = await captureAndDistill(
        { ring, ledger, backlog, distill },
        { topicId: 13, text: 'from now on stop apologizing so much — just fix it', fromUser: true, deterministicWeight: 4, isLearningSignal: true },
      );
      expect(decision).toBe('distill-backlogged');
      expect(backlog.count()).toBe(1);
      // Phase 3: while the breaker is open the backlog is NOT drained.
      const skipped = await drainBacklog({ backlog, ledger, distill, llmAvailable: () => false }, 5);
      expect(skipped.skipped).toBe('breaker-open');
      expect(backlog.count()).toBe(1); // still waiting

      // ── Headroom window: the breaker closes; the periodic/triggered drain runs.
      breakerOpen = false;
      const drained = await drainBacklog({ backlog, ledger, distill, llmAvailable: () => true }, 5);
      expect(drained.recorded).toBe(1);
      expect(backlog.count()).toBe(0); // row deleted once distilled

      // ── Observable on the production read surface: the record reached the ledger.
      const config: InstarConfig = {
        projectName: 'ccb-e2e-rt', agentName: 'E2E', projectDir: dir,
        stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
        monitoring: { correctionLearning: { enabled: true } },
      } as InstarConfig;
      ledger.close(); ledger = null; // release the handle the server re-opens
      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(dir, '.instar')) });
      const res = await request(server.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.records.length).toBe(1);
      expect(res.body.records[0].kind).toBe('user-preference');
      // Privacy: only the scrubbed summary is served — the raw learning never crosses HTTP.
      expect(JSON.stringify(res.body)).not.toContain('stop apologizing repeatedly');
      expect(res.body.records[0].scrubbedSummary).toContain('single brief correction');
    });
  });
});
