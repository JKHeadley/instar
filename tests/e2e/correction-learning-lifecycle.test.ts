/**
 * E2E — Correction & Preference Learning Sentinel (Slice 1b) full lifecycle.
 *
 * Tier 3 of the Testing Integrity Standard. Tests the complete PRODUCTION path
 * via AgentServer.getApp():
 *
 *   Phase 1 — Feature is alive: /corrections returns 200 enabled / 503 off on
 *             the production boot path (the single most important assertion).
 *   Phase 2 — Preference acceptance fixture (§8): a recurring explicit preference
 *             stated across 2 distinct calendar days + 2 topics crosses the gate
 *             and POST /corrections/analyze writes it to .instar/preferences.json
 *             via recordPreference() with provenance: correction-loop — observable
 *             on disk.
 *   Phase 3 — Infra-gap acceptance fixture (§8): the force-push nag across 3
 *             distinct days crosses the gate and is ROUTED (record → acted-on,
 *             routedVia: feedback) — observable on the /corrections read surface.
 *   Phase 4 — Raw-context-never-persisted: the distilled record's raw `learning`
 *             never appears in the served /corrections payload.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'corr-e2e-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

/** Seed N occurrences of one learning into the SAME db the server uses. */
function seed(dbPath: string, opts: {
  kind: 'infra-gap' | 'user-preference';
  learning: string;
  summary: string;
  days: number;
  topics: number;
  count: number;
}): void {
  const ledger = new CorrectionLedger({ dbPath, machineId: 'e2e' });
  try {
    for (let i = 0; i < opts.count; i++) {
      ledger.record({
        kind: opts.kind,
        learning: opts.learning,
        scrubbedSummary: opts.summary,
        deterministicWeight: 3,
        topicId: (i % opts.topics) + 1,
        detectedAt: `2026-05-0${(i % opts.days) + 1}T10:00:00Z`,
      });
    }
  } finally {
    ledger.close();
  }
}

describe('Correction & Preference Learning Sentinel E2E lifecycle', () => {
  describe('Phase 1: feature is alive on the production boot path', () => {
    let onDir: string, offDir: string, onServer: AgentServer, offServer: AgentServer;
    beforeAll(() => {
      onDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-e2e-on-'));
      offDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-e2e-off-'));
      for (const d of [onDir, offDir]) {
        fs.mkdirSync(path.join(d, '.instar', 'state', 'sessions'), { recursive: true });
        fs.mkdirSync(path.join(d, '.instar', 'state', 'jobs'), { recursive: true });
      }
      const mk = (dir: string, enabled: boolean): InstarConfig => ({
        projectName: enabled ? 'corr-e2e-on' : 'corr-e2e-off',
        agentName: 'E2E', projectDir: dir, stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
        ...(enabled ? { monitoring: { correctionLearning: { enabled: true } } } : {}),
      } as InstarConfig);
      onServer = new AgentServer({ config: mk(onDir, true), sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(onDir, '.instar')) });
      offServer = new AgentServer({ config: mk(offDir, false), sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(offDir, '.instar')) });
    });
    afterAll(() => {
      SafeFsExecutor.safeRmSync(onDir, { recursive: true, force: true, operation: 'corr-e2e:p1-on' });
      SafeFsExecutor.safeRmSync(offDir, { recursive: true, force: true, operation: 'corr-e2e:p1-off' });
    });

    it('returns 200 when enabled', async () => {
      const res = await request(onServer.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(200);
    });
    it('returns 503 when disabled', async () => {
      const res = await request(offServer.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(503);
    });
  });

  describe('Phase 2: preference acceptance fixture → recordPreference write on disk', () => {
    let dir: string, server: AgentServer, dbPath: string, prefsPath: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-e2e-pref-'));
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
      dbPath = path.join(dir, '.instar', 'correction-ledger.db');
      prefsPath = path.join(dir, '.instar', 'preferences.json');
      const config: InstarConfig = {
        projectName: 'corr-e2e-pref', agentName: 'E2E', projectDir: dir,
        stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
        monitoring: { correctionLearning: { enabled: true } },
      } as InstarConfig;
      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(dir, '.instar')) });
    });
    afterAll(() => {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'corr-e2e:p2' });
    });

    it('a recurring "no good stopping point" preference (2 days / 2 topics) writes .instar/preferences.json', async () => {
      // The named §8 preference fixture — restated across 2 distinct calendar days.
      seed(dbPath, {
        kind: 'user-preference',
        learning: "don't pause for context length; session length is irrelevant — keep going",
        summary: 'Keep going; do not pause for context length / session length.',
        days: 2, topics: 2, count: 4,
      });
      expect(fs.existsSync(prefsPath)).toBe(false);

      const res = await request(server.getApp()).post('/corrections/analyze').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.routed.toPreferences).toBe(1);

      // Observable on disk: the preferences file the session-start hook injects.
      expect(fs.existsSync(prefsPath)).toBe(true);
      const store = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      expect(store.preferences).toHaveLength(1);
      expect(store.preferences[0].provenance).toBe('correction-loop');
      // The driver records the distilled `learning` (the lesson), per spec §3.6.
      expect(store.preferences[0].learning).toContain('context length');
    });
  });

  describe('Phase 3: force-push-nag infra-gap fixture → routed (acted-on, routedVia feedback)', () => {
    let dir: string, server: AgentServer, dbPath: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-e2e-infra-'));
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
      dbPath = path.join(dir, '.instar', 'correction-ledger.db');
      const config: InstarConfig = {
        projectName: 'corr-e2e-infra', agentName: 'E2E', projectDir: dir,
        stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
        // autoFeedback OFF (default propose-only) — routing still moves the record.
        monitoring: { correctionLearning: { enabled: true } },
      } as InstarConfig;
      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(dir, '.instar')) });
    });
    afterAll(() => {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'corr-e2e:p3' });
    });

    it('the force-push nag across 3 days crosses the gate and is routed to the feedback path', async () => {
      seed(dbPath, {
        kind: 'infra-gap',
        learning: 'the force-push guard cannot tell a safe push from a risky one, so it asks every session',
        summary: 'Force-push authorization nag recurs every session — the guard should distinguish safe pushes.',
        days: 3, topics: 1, count: 4,
      });
      const res = await request(server.getApp()).post('/corrections/analyze').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.analysis.crossed).toBe(1);
      expect(res.body.routed.total).toBe(1);

      // Observable on the read surface: the record is now acted-on via feedback.
      const list = await request(server.getApp()).get('/corrections?status=acted-on').set(auth());
      expect(list.status).toBe(200);
      expect(list.body.records.length).toBe(1);
      expect(list.body.records[0].kind).toBe('infra-gap');
      expect(list.body.records[0].routedVia).toBe('feedback');
    });
  });

  describe('Phase 4: raw context never persists / never serves', () => {
    let dir: string, server: AgentServer, dbPath: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corr-e2e-raw-'));
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
      dbPath = path.join(dir, '.instar', 'correction-ledger.db');
      const config: InstarConfig = {
        projectName: 'corr-e2e-raw', agentName: 'E2E', projectDir: dir,
        stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
        monitoring: { correctionLearning: { enabled: true } },
      } as InstarConfig;
      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(path.join(dir, '.instar')) });
    });
    afterAll(() => {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'corr-e2e:p4' });
    });

    it('the raw learning never appears in the served /corrections payload', async () => {
      seed(dbPath, {
        kind: 'user-preference',
        learning: 'RAW-E2E-LEARNING-MUST-NOT-LEAK-OVER-HTTP',
        summary: 'prefers concise replies',
        days: 1, topics: 1, count: 1,
      });
      const res = await request(server.getApp()).get('/corrections').set(auth());
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('RAW-E2E-LEARNING-MUST-NOT-LEAK-OVER-HTTP');
    });
  });
});
