/**
 * Wiring-integrity test (MESH-SELF-HEAL-SPEC §3.1): the /internal/telegram-forward
 * dispatch seam ACTUALLY writes the serve-progress watermark when the server commits
 * to processing a fetched update. Proves serveProgressedMonoMs is sourced from the
 * real serve path (not a no-op) — the signal the relinquish evaluator reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { readServeProgress } from '../../src/core/serveProgress.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serveseam-'));
  // The handler caches a server version at route-registration; without it the
  // forward 503s "server-boot-incomplete" before reaching the serve-progress write.
  ProcessIntegrity.initialize('1.3.690');
});
afterEach(() => {
  ProcessIntegrity.reset();
  try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/serve-progress-dispatch-seam.test.ts' }); } catch { /* best-effort */ }
});

function ctx(): RouteContext {
  return {
    // authToken '' → the version handshake is skipped (no lifelineVersion needed).
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: '' } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null, getCoherenceJournal: () => null } as any,
    // No sentinel / no messageLedger → the handler reaches the serve-progress write,
    // then falls through to routing. telegram stub satisfies the pre-write calls.
    telegram: {
      logInboundMessage: () => {},
      // Return handled=true so the handler short-circuits right AFTER the
      // serve-progress write (which is before the a2a hook) — avoids exercising
      // the full downstream user-routing/spawn path in this wiring test.
      dispatchAgentMessageHook: async () => true,
      getSessionForTopic: () => null,
      sendToTopic: async () => {},
    } as any,
    scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    correctionLedger: null, coordinator: null,
    startTime: new Date(),
  } as any;
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(ctx()));
  return a;
}

describe('serve-progress dispatch-seam wiring', () => {
  it('writes serve-progress.json when the forward handler processes a fetched update', async () => {
    expect(readServeProgress(stateDir)).toBeNull(); // nothing yet
    // POST WITHOUT lifelineVersion → version handshake skipped; no sentinel/ledger →
    // the handler reaches the serve-progress write before routing.
    await request(app())
      .post('/internal/telegram-forward')
      .send({ topicId: 1, text: 'hello', messageId: 'm-1', fromFirstName: 'T' });
    // Regardless of how the later routing resolves, the watermark must be stamped.
    const rec = readServeProgress(stateDir);
    expect(rec).not.toBeNull();
    expect(typeof rec!.serveProgressedMonoMs).toBe('number');
    expect(typeof rec!.bootId).toBe('string');
    expect(rec!.serverPid).toBe(process.pid);
  });
});
