/**
 * E2E — Self-Violation Signal full lifecycle (Correction & Preference Learning
 * Sentinel extension). Tier 3 of the Testing Integrity Standard.
 *
 * Exercises the COMPLETE production path via AgentServer.getApp():
 *
 *   Phase 1 — Feature is alive: with correctionLearning.enabled +
 *             selfViolationSignal on AND a preference carrying a violationPattern,
 *             a contradicting outbound message (sent through the real
 *             /telegram/reply seam) records a self-violation observable on
 *             /corrections — while the message is delivered UNCHANGED (the
 *             single most important assertion: signal-only, never blocks).
 *   Phase 2 — Dark by default: with selfViolationSignal OFF, the same
 *             contradicting message delivers unchanged and records NOTHING.
 *   Phase 3 — Raw preference text never persists to the wire (toApiView strips
 *             `learning`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'sv-e2e-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

function telegramStub(delivered: Array<{ topicId: number; text: string }>): any {
  return {
    onMessageLogged: null,
    async sendToTopic(topicId: number, text: string) { delivered.push({ topicId, text }); return {}; },
    getSessionForTopic: () => null,
    isSessionAlive: () => true,
  };
}

function bootServer(dir: string, selfViolationSignal: boolean): { server: AgentServer; delivered: Array<{ topicId: number; text: string }> } {
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const delivered: Array<{ topicId: number; text: string }> = [];
  const config: InstarConfig = {
    projectName: 'sv-e2e', agentName: 'E2E', projectDir: dir,
    stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
    monitoring: { correctionLearning: { enabled: true, selfViolationSignal } },
  } as InstarConfig;
  const sm = createMockSessionManager() as any;
  sm.clearInjectionTracker = () => {};
  const server = new AgentServer({
    config, sessionManager: sm, state: new StateManager(path.join(dir, '.instar')), telegram: telegramStub(delivered),
  });
  return { server, delivered };
}

function seedViolatingPref(dir: string, learning = "don't defer work to a fresh session — there is no tail of a session"): void {
  new PreferencesManager(path.join(dir, '.instar')).recordPreference({
    learning, dedupeKey: 'user-preference:fresh', confidence: 0.9, violationPattern: 'regex:fresh session|pick this up later',
  });
}

async function pollRecords(server: AgentServer, min: number): Promise<any[]> {
  for (let i = 0; i < 40; i++) {
    const list = await request(server.getApp()).get('/corrections').set(auth());
    if (list.status === 200 && list.body.records.length >= min) return list.body.records;
    await new Promise((r) => setTimeout(r, 25));
  }
  const last = await request(server.getApp()).get('/corrections').set(auth());
  return last.body?.records ?? [];
}

describe('Self-Violation Signal E2E lifecycle', () => {
  describe('Phase 1: feature alive — contradicting message delivers AND records the signal', () => {
    let dir: string, server: AgentServer, delivered: Array<{ topicId: number; text: string }>;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-e2e-on-'));
      ({ server, delivered } = bootServer(dir, true));
      seedViolatingPref(dir);
    });
    afterAll(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'sv-e2e:p1' }); });

    it('the message is delivered UNCHANGED (never blocked) and a self-violation is recorded', async () => {
      const violating = "I'll pick this up later in a fresh session so the context window stays clean.";
      const res = await request(server.getApp()).post('/telegram/reply/13201').set(auth()).send({ text: violating });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // Signal-only: the exact text reached the adapter, untouched.
      expect(delivered.at(-1)?.text).toBe(violating);

      const records = await pollRecords(server, 1);
      expect(records.length).toBe(1);
      expect(records[0].kind).toBe('user-preference');
      expect(records[0].topicId).toBe(13201);
    });
  });

  describe('Phase 2: dark by default — sub-flag OFF records nothing', () => {
    let dir: string, server: AgentServer, delivered: Array<{ topicId: number; text: string }>;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-e2e-dark-'));
      ({ server, delivered } = bootServer(dir, false));
      seedViolatingPref(dir);
    });
    afterAll(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'sv-e2e:p2' }); });

    it('the same contradicting message delivers unchanged and records nothing', async () => {
      const violating = "Let me start a fresh session for this.";
      const res = await request(server.getApp()).post('/telegram/reply/13202').set(auth()).send({ text: violating });
      expect(res.status).toBe(200);
      expect(delivered.at(-1)?.text).toBe(violating);
      await new Promise((r) => setTimeout(r, 150));
      const list = await request(server.getApp()).get('/corrections').set(auth());
      expect(list.status).toBe(200);
      expect(list.body.records).toHaveLength(0);
    });
  });

  describe('Phase 3: raw preference text never serves over HTTP', () => {
    let dir: string, server: AgentServer;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-e2e-raw-'));
      ({ server } = bootServer(dir, true));
      seedViolatingPref(dir, 'RAW-SV-E2E-MUST-NOT-LEAK fresh session');
    });
    afterAll(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'sv-e2e:p3' }); });

    it('the served /corrections payload never contains the raw violated-preference text', async () => {
      await request(server.getApp()).post('/telegram/reply/13203').set(auth())
        .send({ text: 'going to a fresh session now' });
      const records = await pollRecords(server, 1);
      expect(records.length).toBe(1);
      const list = await request(server.getApp()).get('/corrections').set(auth());
      expect(JSON.stringify(list.body)).not.toContain('RAW-SV-E2E-MUST-NOT-LEAK');
    });
  });
});
