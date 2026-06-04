// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Update-Relevance Gate.
 *
 * Per TESTING-INTEGRITY-SPEC: the gate has no dedicated route — it is wired INTO
 * the update-class chokepoint (POST /telegram/post-update). The "is it alive?"
 * question is therefore: when the REAL AgentServer boots the way server.ts does,
 * with an UpdateRelevanceGate constructed and passed through, does the
 * options.updateRelevanceGate → ctx.updateRelevanceGate wiring hold, and does the
 * route ACTUALLY enforce relevance end-to-end over real HTTP?
 *
 * This boots the real AgentServer (same path server.ts uses), passes a real
 * UpdateRelevanceGate (with a deterministic mock provider), and proves over real
 * HTTP that:
 *   - an internal-plumbing update is SUPPRESSED (200 {suppressed:true}, not sent)
 *   - a genuinely user-relevant update is DELIVERED unchanged (200 {topicId})
 *
 * If the AgentServer wiring (the line that maps options.updateRelevanceGate into
 * the route context) regressed to null, the suppress assertion would fail because
 * the gate would be a no-op and the message would send.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { UpdateRelevanceGate } from '../../src/core/UpdateRelevanceGate.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null, clearInjectionTracker: () => {} };
}

const UPDATES_TOPIC = 77;

describe('Update-Relevance Gate E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const sent: Array<{ topicId: number; text: string }> = [];
  const AUTH = 'test-e2e-update-relevance';

  // Deterministic provider keyed on the CANDIDATE region only. (The gate's system
  // prompt embeds example texts — including "Sibling Agent Server Control" and the
  // dashboard line — so matching the whole prompt would classify everything as
  // internal. We inspect only the text after the CANDIDATE marker.)
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (prompt: string) => {
      const candidate = prompt.split('CANDIDATE MESSAGE').pop() ?? '';
      const internal = /restart other agents|SocketDisconnectSentinel|apprenticeship cycle/i.test(candidate);
      return JSON.stringify(
        internal
          ? { verdict: 'internal', reason: 'agent-internal plumbing', plainText: '' }
          : { verdict: 'user-relevant', reason: 'owner-visible', plainText: '' },
      );
    }),
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-relevance-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }),
    );

    const config: InstarConfig = {
      projectName: 'e2e',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH,
      requestTimeoutMs: 10000,
      version: '0.0.0',
      developmentAgent: true, // resolves the gate's enablement → live
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
    } as InstarConfig;

    const state = new StateManager(stateDir);
    state.set('agent-updates-topic', UPDATES_TOPIC);

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state,
      telegram: {
        sendToTopic: async (topicId: number, text: string) => {
          sent.push({ topicId, text });
          return { messageId: 1 };
        },
      } as any,
      updateRelevanceGate: new UpdateRelevanceGate(provider),
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/update-relevance-gate-lifecycle.test.ts',
    });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('suppresses an internal-plumbing update end-to-end (200 {suppressed:true}, not sent)', async () => {
    const before = sent.length;
    const res = await request(app)
      .post('/telegram/post-update')
      .set(auth())
      .send({
        text: 'Sibling Agent Server Control — I can now restart other agents’ servers during fleet maintenance.',
      });

    expect(res.status).toBe(200);
    expect(res.body.suppressed).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(sent.length).toBe(before); // never reached the user
  });

  it('delivers a genuinely user-relevant update unchanged (200 {topicId}, sent)', async () => {
    const text = 'Your dashboard now works on your phone — same PIN, just open the link I send you.';
    const res = await request(app).post('/telegram/post-update').set(auth()).send({ text });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.topicId).toBe(UPDATES_TOPIC);
    expect(sent.some((s) => s.topicId === UPDATES_TOPIC && s.text === text)).toBe(true);
  });

  it('the route is Bearer-auth gated (401 without a token)', async () => {
    const res = await request(app).post('/telegram/post-update').send({ text: 'hello' });
    expect(res.status).toBe(401);
  });
});
