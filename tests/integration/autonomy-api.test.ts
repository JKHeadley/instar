/**
 * Integration test — Autonomy API routes via HTTP.
 *
 * Spins up a minimal AgentServer with AutonomyProfileManager
 * and tests the REST endpoints end-to-end over HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';

// We'll use the route handler directly via a lightweight express app
import express from 'express';
import { createRoutes } from '../../src/server/routes.js';
import type { Server } from 'node:http';

let project: TempProject;
let server: Server;
let baseUrl: string;
let autonomyManager: AutonomyProfileManager;

function makeConfig(stateDir: string): InstarConfig {
  return {
    projectDir: project.dir,
    stateDir,
    projectName: 'test-project',
    agentName: 'test-agent',
    port: 0, // random port
    agentAutonomy: { level: 'collaborative' },
  } as InstarConfig;
}

describe('Autonomy API Routes (integration)', () => {
  beforeAll(async () => {
    project = createTempProject();
    const config = makeConfig(project.stateDir);
    const state = new StateManager(project.stateDir);

    autonomyManager = new AutonomyProfileManager({
      stateDir: project.stateDir,
      config,
    });

    const app = express();
    app.use(express.json());

    // Create routes with minimal context — only autonomyManager is needed
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

  // ── GET /autonomy ──────────────────────────────────────────────

  describe('GET /autonomy', () => {
    it('returns full dashboard', async () => {
      const res = await fetch(`${baseUrl}/autonomy`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.profile).toBe('collaborative');
      expect(body.resolved).toBeDefined();
      expect(body.resolved.profile).toBe('collaborative');
      expect(body.summary).toBeTruthy();
      expect(body.availableProfiles).toHaveLength(4);
      expect(body.notifications).toBeDefined();
      expect(body.history).toBeInstanceOf(Array);
    });
  });

  // ── GET /autonomy/summary ──────────────────────────────────────

  describe('GET /autonomy/summary', () => {
    it('returns natural language summary', async () => {
      const res = await fetch(`${baseUrl}/autonomy/summary`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.summary).toContain('collaborative');
      expect(typeof body.summary).toBe('string');
    });
  });

  // ── POST /autonomy/profile ────────────────────────────────────

  describe('POST /autonomy/profile', () => {
    it('refuses a wider profile from the token (trust-journey decision 4)', async () => {
      const res = await fetch(`${baseUrl}/autonomy/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: 'autonomous', reason: 'Integration test' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('operator-approval-required');
      expect(autonomyManager.getProfile()).toBe('collaborative');
    });

    it('rejects invalid profile', async () => {
      const res = await fetch(`${baseUrl}/autonomy/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: 'invalid-level', reason: 'test' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid profile');
    });

    it('rejects missing profile', async () => {
      const res = await fetch(`${baseUrl}/autonomy/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test' }),
      });

      expect(res.status).toBe(400);
    });

    it('uses default reason when not provided', async () => {
      const res = await fetch(`${baseUrl}/autonomy/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: 'supervised' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.profile).toBe('supervised');
    });
  });

  // ── PATCH /autonomy/notifications ──────────────────────────────

  describe('PATCH /autonomy/notifications', () => {
    it('updates notification preferences', async () => {
      const res = await fetch(`${baseUrl}/autonomy/notifications`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evolutionDigest: 'daily' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notifications.evolutionDigest).toBe('daily');
    });

    it('preserves unmodified preferences', async () => {
      // First set a preference
      await fetch(`${baseUrl}/autonomy/notifications`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trustElevationSuggestions: false }),
      });

      // Then update a different one
      const res = await fetch(`${baseUrl}/autonomy/notifications`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evolutionDigest: 'hourly' }),
      });

      const body = await res.json();
      expect(body.notifications.evolutionDigest).toBe('hourly');
      expect(body.notifications.trustElevationSuggestions).toBe(false);
    });
  });

  // ── GET /autonomy/history ──────────────────────────────────────

  describe('GET /autonomy/history', () => {
    it('returns profile change history', async () => {
      const res = await fetch(`${baseUrl}/autonomy/history`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.history).toBeInstanceOf(Array);
      expect(body.history.length).toBeGreaterThan(0);
      // Previous POST tests changed the profile, so we should have history
      const entry = body.history[body.history.length - 1];
      expect(entry.at).toBeTruthy();
      expect(entry.to).toBeTruthy();
    });
  });

  // ── Profile change persists across requests ────────────────────

  describe('state persistence', () => {
    it('profile change in POST is reflected in subsequent GET', async () => {
      await fetch(`${baseUrl}/autonomy/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: 'cautious', reason: 'Persistence test' }),
      });

      const res = await fetch(`${baseUrl}/autonomy`);
      const body = await res.json();
      expect(body.profile).toBe('cautious');
      expect(body.resolved.autoApplyUpdates).toBe(false);
    });
  });
});
