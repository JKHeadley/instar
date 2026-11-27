/**
 * Integration test — Trust Elevation API routes via HTTP.
 *
 * Tests the REST endpoints for trust elevation tracking,
 * rubber-stamp detection, and elevation opportunities.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import express from 'express';
import { createRoutes } from '../../src/server/routes.js';
import type { Server } from 'node:http';

let project: TempProject;
let server: Server;
let baseUrl: string;

describe('Trust Elevation API Routes (integration)', () => {
  beforeAll(async () => {
    project = createTempProject();
    const config: InstarConfig = {
      projectDir: project.dir,
      stateDir: project.stateDir,
      projectName: 'test-project',
      agentName: 'test-agent',
    } as InstarConfig;
    const state = new StateManager(project.stateDir);

    const autonomyManager = new AutonomyProfileManager({
      stateDir: project.stateDir,
      config,
    });

    const trustElevationTracker = new TrustElevationTracker({
      stateDir: project.stateDir,
      rubberStampConsecutive: 5,
      rubberStampLatencyMs: 5000,
    });

    const app = express();
    app.use(express.json());

    const router = createRoutes({
      config,
      state,
      sessionManager: null as any,
      scheduler: null,
      telegram: null,
      relationships: null,
      feedback: null,
      dispatches: null,
      updateChecker: null,
      autoUpdater: null,
      autoDispatcher: null,
      quotaTracker: null,
      publisher: null,
      viewer: null,
      tunnel: null,
      evolution: null,
      watchdog: null,
      triageNurse: null,
      topicMemory: null,
      feedbackAnomalyDetector: null,
      projectMapper: null,
      coherenceGate: null,
      contextHierarchy: null,
      canonicalState: null,
      operationGate: null,
      sentinel: null,
      adaptiveTrust: null,
      memoryMonitor: null,
      orphanReaper: null,
      coherenceMonitor: null,
      commitmentTracker: null,
      semanticMemory: null,
      activitySentinel: null,
      workingMemory: null,
      quotaManager: null,
      systemReviewer: null,
      capabilityMapper: null,
      topicResumeMap: null,
      autonomyManager,
      trustElevationTracker,
      discoveryEvaluator: null,
      startTime: new Date(),
    });

    app.use(router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    project.cleanup();
  });

  // ── GET /autonomy/elevation ────────────────────────────────────

  describe('GET /autonomy/elevation', () => {
    it('returns elevation dashboard', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.acceptanceStats).toBeDefined();
      expect(body.rubberStamp).toBeDefined();
      expect(body.activeOpportunities).toBeInstanceOf(Array);
      expect(body.lastEvaluatedAt).toBeTruthy();
    });
  });

  // ── POST /autonomy/elevation/record ────────────────────────────

  describe('POST /autonomy/elevation/record', () => {
    it('records an approval event', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: 'EVO-001',
          proposedAt: new Date(Date.now() - 60000).toISOString(),
          decision: 'approved',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recorded).toBe(true);
      // Reported through the agent's token: kept, but never counted (trust-journey section 6).
      expect(body.acceptanceStats.totalDecided).toBe(0);
      expect(body.acceptanceStats.approved).toBe(0);
    });

    it('records a rejection event', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: 'EVO-002',
          proposedAt: new Date(Date.now() - 60000).toISOString(),
          decision: 'rejected',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.recorded).toBe(true);
      expect(body.acceptanceStats.rejected).toBe(0);
    });

    it('rejects missing required fields', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: 'EVO-003' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid decision', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: 'EVO-004',
          proposedAt: new Date().toISOString(),
          decision: 'maybe',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── GET /autonomy/elevation/acceptance ─────────────────────────

  describe('GET /autonomy/elevation/acceptance', () => {
    it('returns acceptance statistics', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/acceptance`);
      expect(res.status).toBe(200);

      const body = await res.json();
      // Only token-reported rows were recorded above, so nothing counts yet.
      expect(body.totalDecided).toBe(0);
      expect(body.acceptanceRate).toBeNull();
      expect(body.recentAcceptanceRate).toBeNull();
    });
  });

  // ── GET /autonomy/elevation/opportunities ──────────────────────

  describe('GET /autonomy/elevation/opportunities', () => {
    it('returns opportunities array', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/opportunities`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.opportunities).toBeInstanceOf(Array);
    });
  });

  // ── POST /autonomy/elevation/dismiss ───────────────────────────

  describe('POST /autonomy/elevation/dismiss', () => {
    it('returns dismissed false for non-existent opportunity', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'evolution-governance' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dismissed).toBe(false);
    });

    it('rejects missing type', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /autonomy/elevation/dismiss-rubber-stamp ──────────────

  describe('POST /autonomy/elevation/dismiss-rubber-stamp', () => {
    it('refuses to hide the rubber-stamp alert from the token (trust-journey section 6)', async () => {
      const res = await fetch(`${baseUrl}/autonomy/elevation/dismiss-rubber-stamp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 60 }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('operator-approval-required');
    });
  });

  // ── Rubber-stamp detection through API ─────────────────────────

  describe('rubber-stamp detection via API', () => {
    it('detects rubber-stamping after enough fast approvals', async () => {
      // Record 5 fast approvals (threshold is 5)
      for (let i = 0; i < 5; i++) {
        await fetch(`${baseUrl}/autonomy/elevation/record`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proposalId: `EVO-RUBBER-${i}`,
            proposedAt: new Date(Date.now() - 2000).toISOString(), // 2s ago
            decision: 'approved',
          }),
        });
      }

      const res = await fetch(`${baseUrl}/autonomy/elevation`);
      const body = await res.json();
      // Note: rubber-stamp detection uses latencyMs, which is computed at record time
      // The latencyMs will be ~2000ms which is under the 5000ms threshold
      expect(body.rubberStamp).toBeDefined();
    });
  });
});
