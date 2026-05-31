/**
 * E2E test — Preferences session-start injection (Correction & Preference
 * Learning Sentinel, Slice 1a) full lifecycle.
 *
 * Tier 3 of the Testing Integrity Standard. Tests the complete PRODUCTION path:
 *   Phase 1 — Feature is alive: the route is wired into AgentServer the same
 *             way production wires it (200 when enabled, 503 when off). This is
 *             the single most important assertion — it mirrors the ORG-INTENT
 *             E2E precedent exactly (one AgentServer per describe, getApp()).
 *   Phase 2 — The generated session-start hook's preference-injection logic
 *             (the SAME bash + python that PostUpdateMigrator.getSessionStartHook()
 *             installs) runs against a LIVE server and emits the
 *             <auto-learned-preference> block when a preference exists, and
 *             emits nothing when the feature is off (503-tolerant fail-open).
 *
 * WHY PHASE 2 RUNS A SLICE OF THE HOOK, NOT THE WHOLE SCRIPT:
 * The full session-start hook also exercises shared-state session-binding,
 * topic-context, project-map, etc. — unrelated subsystems that need a full
 * AgentServer to answer without blocking. Slice 1a's contract is exactly the
 * preference-fetch block, so Phase 2 extracts that block verbatim from the
 * generated hook source and runs it against a real server. The full hook
 * source is also asserted to contain the wiring (so a refactor that drops the
 * fetch is caught).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import request from 'supertest';
import express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import type { RouteContext } from '../../src/server/routes.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const execFileAsync = promisify(execFile);

const AUTH_TOKEN = 'test-prefs-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

describe('Preferences session-start injection E2E lifecycle', () => {
  // ── Phase 1: Feature is alive on the production AgentServer boot path ──
  describe('Phase 1: Feature is alive (production AgentServer boot path)', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-e2e-on-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'prefs-e2e' }));

      const config: InstarConfig = {
        projectName: 'prefs-e2e-on',
        agentName: 'E2E Agent',
        projectDir: tmpDir,
        stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
        monitoring: { correctionLearning: { enabled: true } },
      } as InstarConfig;

      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
      app = server.getApp();
    });

    afterAll(async () => {
      try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'preferences-session-context-lifecycle:phase1' });
    });

    it('returns 200 when enabled — route is wired into production', async () => {
      const res = await request(app).get('/preferences/session-context').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.present).toBe(false); // no preferences recorded yet
    });

    it('returns the structured block once a preference is recorded on disk', async () => {
      new PreferencesManager(stateDir).recordPreference({
        learning: 'Skip the preamble; give the answer first.',
        dedupeKey: 'user-preference:answer-first',
        confidence: 0.9,
      });
      const res = await request(app).get('/preferences/session-context').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.present).toBe(true);
      expect(res.body.block).toContain('Skip the preamble; give the answer first.');
      expect(res.body.block).toContain("<auto-learned-preference src='correction-loop'>");
    });
  });

  describe('Phase 1b: 503 on the same boot path when disabled', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: AgentServer;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-e2e-off-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
      fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'prefs-e2e-off' }));

      const config: InstarConfig = {
        projectName: 'prefs-e2e-off',
        agentName: 'E2E Agent',
        projectDir: tmpDir,
        stateDir,
        port: 0,
        authToken: AUTH_TOKEN,
        // correctionLearning omitted → disabled
      } as InstarConfig;

      server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
      app = server.getApp();
    });

    afterAll(async () => {
      try { await (server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'preferences-session-context-lifecycle:phase1b' });
    });

    it('returns 503 when disabled', async () => {
      const res = await request(app).get('/preferences/session-context').set(auth());
      expect(res.status).toBe(503);
    });
  });

  // ── Phase 2: the generated hook's preference-injection logic ──
  describe('Phase 2: session-start hook injects the <auto-learned-preference> block', () => {
    let tmpDir: string;
    let stateDir: string;
    let server: http.Server;
    let port: number;

    function makeCtx(enabled: boolean): RouteContext {
      return {
        config: {
          projectName: 'prefs-hook-e2e', projectDir: tmpDir, stateDir, port,
          authToken: AUTH_TOKEN,
          monitoring: { correctionLearning: { enabled, maxInjectedPreferencesBytes: 4000 } },
          sessions: {} as any, scheduler: {} as any,
        } as any,
        sessionManager: { listRunningSessions: () => [] } as any,
        state: { getJobState: () => null, getSession: () => null } as any,
        scheduler: null, telegram: null, relationships: null, feedback: null,
        dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
        quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
        watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
        discoveryEvaluator: null, startTime: new Date(),
      } as unknown as RouteContext;
    }

    async function startServer(enabled: boolean): Promise<void> {
      const appx = express();
      appx.use(express.json());
      appx.use(authMiddleware(AUTH_TOKEN));
      appx.use('/', createRoutes(makeCtx(enabled)));
      await new Promise<void>((resolve) => {
        // Listen on all interfaces so the hook's `http://localhost:PORT` fetch
        // resolves whether localhost maps to 127.0.0.1 or ::1 on this host.
        server = appx.listen(0, () => {
          port = (server.address() as { port: number }).port;
          resolve();
        });
      });
    }

    async function stopServer(): Promise<void> {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    /**
     * Extract the preference-injection block from the generated hook source —
     * the lines between the "AUTO-LEARNED PREFERENCES injection" comment and the
     * next "# BEGIN" marker — and run JUST that block against the live server.
     * This is the exact bash + python the production hook runs for this feature.
     */
    function extractPrefBlock(): string {
      const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port, authToken: AUTH_TOKEN, agentName: 'prefs-hook-e2e' });
      const src = migrator.getHookContent('session-start');
      const start = src.indexOf('# AUTO-LEARNED PREFERENCES injection');
      expect(start).toBeGreaterThanOrEqual(0);
      const after = src.indexOf('# BEGIN integrated-being-v2', start);
      expect(after).toBeGreaterThan(start);
      return src.slice(start, after);
    }

    // Async exec so the in-process Express server's event loop stays free to
    // answer the curl while bash runs in a child process (a SYNC exec would
    // deadlock — the single Node event loop can't serve the request while
    // blocked inside execFileSync).
    async function runPrefBlock(): Promise<string> {
      const block = extractPrefBlock();
      // Provide the PORT/TOKEN env the surrounding hook would have set.
      const script = `#!/bin/bash\nPORT=${port}\nTOKEN="${AUTH_TOKEN}"\n${block}`;
      const scriptPath = path.join(tmpDir, 'pref-block.sh');
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      const { stdout } = await execFileAsync('bash', [scriptPath], { encoding: 'utf-8' });
      return stdout;
    }

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-hook-e2e-'));
      stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
    });

    afterAll(async () => {
      await stopServer();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'preferences-session-context-lifecycle:phase2' });
    });

    it('the full hook source wires the /preferences/session-context fetch', () => {
      const migrator = new PostUpdateMigrator({ projectDir: tmpDir, stateDir, port: 0, authToken: AUTH_TOKEN, agentName: 'x' });
      const src = migrator.getHookContent('session-start');
      expect(src).toContain('/preferences/session-context');
      expect(src).toContain('PREFS_BLOCK');
    });

    it('emits the <auto-learned-preference> block when enabled + a preference exists', async () => {
      new PreferencesManager(stateDir).recordPreference({
        learning: 'Lead with the one action, no preamble.',
        dedupeKey: 'user-preference:lead-action',
        confidence: 0.85,
      });
      await startServer(true);
      const out = await runPrefBlock();
      await stopServer();

      expect(out).toContain("<auto-learned-preference src='correction-loop'>");
      expect(out).toContain('Lead with the one action, no preamble.');
    });

    it('emits NO block when the feature is OFF (503-tolerant fail-open)', async () => {
      await startServer(false);
      const out = await runPrefBlock();
      await stopServer();
      expect(out).not.toContain('<auto-learned-preference');
      expect(out.trim()).toBe('');
    });
  });
});
